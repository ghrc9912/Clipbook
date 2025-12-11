// functions/hfChat.js
// Rule-based ClipBook Assistant (NO external LLM calls)
// Works with Firestore data: users/{uid}/playlists/{plist}, users/{uid}/clips/{clip}

const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// simple rate limiter (in-memory)
const WINDOW_MS = 60_000;
const MAX_REQ = 20;
const buckets = {};
function withinLimit(uid) {
  const now = Date.now();
  const arr = buckets[uid] || [];
  const recent = arr.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQ) {
    buckets[uid] = recent;
    return false;
  }
  recent.push(now);
  buckets[uid] = recent;
  return true;
}

// basic text utilities
function normalize(s) {
  return (s || "").toString().toLowerCase();
}
function scoreText(query, text) {
  // simple bag-of-words overlapping score
  if (!query || !text) return 0;
  const q = normalize(query).split(/\s+/).filter(Boolean);
  const t = normalize(text);
  let score = 0;
  for (const w of q) if (t.indexOf(w) !== -1) score += 1;
  return score;
}
function shortText(s, n = 200) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n).trim() + "...";
}

// build playlist context (list of top clips)
async function fetchPlaylistClips(uid, playlistId, limit = 12) {
  if (!uid || !playlistId) return [];
  try {
    const clipsSnap = await db
      .collection("users").doc(uid)
      .collection("clips")
      .where("playlistIds", "array-contains", playlistId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return clipsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("fetchPlaylistClips error:", e);
    return [];
  }
}

// Intent detection (very simple rules)
function detectIntent(message) {
  const m = normalize(message);
  if (m.includes("summar") || m.includes("overview") || m.includes("summary")) return "summarize";
  if (m.includes("recommend") || m.includes("next") || m.includes("what next") || m.includes("suggest")) return "recommend";
  if (m.includes("quiz") || m.includes("question") || m.includes("test me")) return "quiz";
  if (m.includes("plan") || m.includes("study plan")) return "plan";
  if (m.includes("find") || m.includes("search") || m.includes("which") || m.includes("where") || m.includes("?")) return "search";
  return "search"; // default: search/match
}

// Summarize: create short summary from clip titles+descriptions
function summarizeClips(clips) {
  if (!clips || clips.length === 0) return "No clips found in this playlist.";
  // pick up to 5 clips
  const top = clips.slice(0, 5);
  const bullets = top.map((c, i) => `${i+1}. ${c.customTitle || c.title || shortText(c.originalUrl || "Untitled", 40)} — ${shortText(c.description || "", 120)}`);
  // naive summary: take common words from titles
  const titles = top.map(c => c.customTitle || c.title || "").join(" ");
  const words = titles.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const topWords = Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0,3).map(x=>x[0]);
  const summary = `This playlist covers: ${topWords.length ? topWords.join(", ") : "various topics"}. Key videos:\n` + bullets.join("\n");
  return summary;
}

// Recommend: choose the most relevant unseen or highest-scoring clip
function recommendClip(clips, previousTitles = []) {
  if (!clips || clips.length === 0) return null;
  // prefer clips not listed in previousTitles
  const lowerPrev = previousTitles.map(s => normalize(s));
  for (const c of clips) {
    if (!lowerPrev.includes(normalize(c.customTitle || c.title || ""))) {
      return c;
    }
  }
  // default to most recent
  return clips[0];
}

// Quiz: produce simple questions from clip titles
function generateQuiz(clips, num = 3) {
  if (!clips || clips.length === 0) return ["No clips available for quiz."];
  const q = [];
  const top = clips.slice(0, Math.min(num, clips.length));
  for (const c of top) {
    const title = c.customTitle || c.title || "Untitled";
    // produce a simple question
    q.push(`What is the main topic of "${shortText(title, 60)}"?`);
  }
  return q;
}

// Search & match
function searchClips(clips, query, limit = 5) {
  const scored = clips.map(c => {
    const s = (c.customTitle || c.title || "") + " " + (c.description || "");
    return { clip: c, score: scoreText(query, s) };
  }).filter(x => x.score > 0);
  const sorted = scored.sort((a,b) => b.score - a.score).slice(0, limit);
  return sorted.map(x => x.clip);
}

// The callable function
exports.hfChat = functions.https.onCall(async (data, context) => {
  const uid = (context && context.auth && context.auth.uid) || "anonymous";
  if (!withinLimit(uid)) return { error: "Rate limit exceeded. Try again shortly." };

  const message = (data && data.message) ? String(data.message) : "";
  const playlistId = (data && data.playlistId) ? String(data.playlistId) : null;

  if (!message || message.trim().length === 0) return { error: "Empty message" };

  // load playlist clips (if provided)
  const clips = playlistId ? await fetchPlaylistClips(uid, playlistId, 25) : [];
  const intent = detectIntent(message);

  // response object
  try {
    if (intent === "summarize") {
      const summary = summarizeClips(clips);
      return { reply: summary };
    }

    if (intent === "recommend") {
      const rec = recommendClip(clips, []);
      if (!rec) return { reply: "No clips found to recommend." };
      const text = `Recommended: ${rec.customTitle || rec.title || rec.originalUrl}\n\n${shortText(rec.description || "No description", 300)}\n\nLink: ${rec.originalUrl || "N/A"}`;
      return { reply: text };
    }

    if (intent === "quiz") {
      const qs = generateQuiz(clips, 5);
      return { reply: "Quiz:\n" + qs.map((x,i) => `${i+1}. ${x}`).join("\n") };
    }

    if (intent === "plan") {
      // simple study plan: 3-day plan using up to 6 clips
      const items = clips.slice(0, 6);
      const plan = [
        `Study plan for this playlist (${items.length} clips):`,
        `Day 1: Watch ${items.slice(0,2).map((c,i)=>`${i+1}. ${c.customTitle||c.title||"Untitled"}`).join(", ")}`,
        `Day 2: Watch ${items.slice(2,4).map((c,i)=>`${i+1}. ${c.customTitle||c.title||"Untitled"}`).join(", ") || "No clips"}`,
        `Day 3: Watch ${items.slice(4,6).map((c,i)=>`${i+1}. ${c.customTitle||c.title||"Untitled"}`).join(", ") || "No clips"}`,
        `Tip: Take notes and try a short recap after each video.`
      ].join("\n");
      return { reply: plan };
    }

    // default: search/match
    if (clips && clips.length) {
      const matches = searchClips(clips, message, 5);
      if (matches.length) {
        const lines = matches.map((c, i) => `${i+1}. ${c.customTitle || c.title || "Untitled"} — ${shortText(c.description || "", 160)}\nLink: ${c.originalUrl || "N/A"}`);
        return { reply: `Found ${matches.length} relevant clips:\n\n${lines.join("\n\n")}` };
      }
    }

    // fallback generic reply (when no playlist or no matches)
    // provide helpful suggestions
    const fallback = `I couldn't find direct matches. Try asking:\n- "summarize playlist"\n- "recommend next"\n- "quiz me"\nOr include keywords from the video title or description.`;
    return { reply: fallback };

  } catch (err) {
    console.error("hfChat rule-based error:", err);
    return { error: "Server error processing request." };
  }
});
