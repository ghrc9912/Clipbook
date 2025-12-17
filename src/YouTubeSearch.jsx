// src/YouTubeSearch.jsx
// YouTube search + AI auto-tagging (AI tags ON by default, hidden toggle).
// Auto-tags limited to 3.

import { useState } from "react";
import { db, auth } from "./firebase";
import { addDoc, collection } from "firebase/firestore";

// small helper to truncate long text before sending to model
const truncate = (s, n = 1500) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

const normalizeTag = (t) => (t || "").toString().trim().toLowerCase();

// rule-based fallback tag generator (kept) — now returns up to 3 tags
const generateAutoTags = (title, desc) => {
  const text = `${title || ""} ${desc || ""}`.toLowerCase();
  const map = {
    react: "web-dev",
    javascript: "web-dev",
    python: "python",
    pandas: "data-science",
    "machine learning": "machine-learning",
    ml: "machine-learning",
    tutorial: "tutorial",
    gaming: "gaming",
    nature: "nature",
  };
  const tags = new Set();
  for (const [kw, tag] of Object.entries(map)) {
    if (text.includes(kw)) tags.add(tag);
    if (tags.size >= 3) break;
  }
  if (tags.size === 0) tags.add("uncategorized");
  return Array.from(tags).slice(0, 3).map(normalizeTag);
};

// AI tag generator (calls your HF/Groq proxy) — will limit to 3 tags
async function generateAITags(title, desc) {
  const HF_PROXY_ENDPOINT = "https://api-4wepxhinxa-uc.a.run.app/hf-chat";
  const shortTitle = truncate(title, 800);
  const shortDesc = truncate(desc, 1800);

  const prompt = `You are a concise tag generator. Given the video title and description, return a JSON object with a single field "tags" containing up to 3 short, single-word or short-phrase tags suitable as categories. Do not include explanation.

Title: ${shortTitle}

Description: ${shortDesc}

Return example:
{"tags": ["python", "data-science", "pandas"]}`;

  const resp = await fetch(HF_PROXY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error("AI tagger failed: " + resp.status + " " + body);
  }

  const j = await resp.json().catch(() => null);
  let txt = "";
  if (!j) txt = "";
  else if (typeof j.result === "string") txt = j.result;
  else if (Array.isArray(j.result) && j.result[0]?.generated_text) txt = j.result[0].generated_text;
  else if (j.result && typeof j.result === "object") txt = JSON.stringify(j.result);
  else txt = JSON.stringify(j);

  try {
    const firstBrace = txt.indexOf("{");
    const lastBrace = txt.lastIndexOf("}");
    const jsonText = firstBrace !== -1 && lastBrace !== -1 ? txt.slice(firstBrace, lastBrace + 1) : txt;
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed.tags)) return parsed.tags.map(normalizeTag).filter(Boolean).slice(0, 3);
    if (typeof parsed.tags === "string") return parsed.tags.split(",").map((t) => normalizeTag(t)).filter(Boolean).slice(0, 3);
  } catch (e) {
    const commaSplit = txt.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    const candidate = commaSplit.filter((x) => x.length <= 30).slice(0, 3).map(normalizeTag);
    if (candidate.length) return candidate;
    throw new Error("AI response could not be parsed.");
  }
  throw new Error("AI response did not contain tags.");
}

export default function YouTubeSearch({ onSaved }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [useAITags] = useState(true); // hidden toggle, default ON
  const apiKey = import.meta.env.VITE_YT_API_KEY;

  const search = async () => {
    if (!q) return alert("Enter a search term.");
    if (!apiKey) {
      console.error("YouTube API key not set. Add VITE_YT_API_KEY to your .env");
      return alert("YouTube API key not configured. Check .env.local.");
    }

    setLoading(true);
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(
        q
      )}&key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        console.error("YouTube API error", res.status, body);
        throw new Error("YouTube API error: " + res.status);
      }
      const data = await res.json();
      setResults(data.items || []);
    } catch (err) {
      console.error("YouTube search failed:", err);
      alert("YouTube search failed. Check console for details.");
    } finally {
      setLoading(false);
    }
  };

  const saveResult = async (item) => {
    if (!auth.currentUser) return alert("Sign in first.");

    const videoId = item.id?.videoId || (item.id && item.id.videoId) || null;
    if (!videoId) return alert("Invalid video item.");

    const title = item.snippet?.title || "";
    const desc = item.snippet?.description || "";
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    let autoTags = [];
    if (useAITags) {
      try {
        autoTags = await generateAITags(title, desc);
      } catch (err) {
        console.warn("AI tagging failed, falling back to rule tags", err);
        autoTags = generateAutoTags(title, desc);
      }
    } else {
      autoTags = generateAutoTags(title, desc);
    }

    // final safety: ensure normalized & only 3
    autoTags = Array.from(new Set(autoTags.map(normalizeTag))).filter(Boolean).slice(0, 3);

    try {
      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl: watchUrl,
        videoSite: "youtube",
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        embedable: true,
        watchUrl,
        customTitle: title,
        description: desc,
        playlistIds: [],
        tags: autoTags,
        autoTagsGenerated: !!useAITags,
        createdAt: Date.now(),
      });

      if (onSaved) onSaved();
      alert("Saved to ClipBook.");
    } catch (err) {
      console.error("Save failed:", err);
      alert("Save failed. Check console.");
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <h3>Search YouTube</h3>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search YouTube (example: linear algebra lecture)"
          style={{ flex: 1, padding: 8 }}
        />
        <button>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <img src="/yt-icon.png" width="18" alt="" />
          Search YouTube
          </span>
        </button>

      </div>

      <div
        style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
          gap: 12,
        }}
      >
        {results.map((it) => (
          <div key={it.id?.videoId || Math.random()} style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
            <img
              src={it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url}
              alt={it.snippet?.title}
              style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 4 }}
            />
            <div style={{ fontWeight: "bold", marginTop: 6 }}>{it.snippet?.title}</div>
            <div style={{ marginTop: 6, fontSize: 13, height: 48, overflow: "hidden", whiteSpace: "normal" }}>
              {it.snippet?.description}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <a href={`https://www.youtube.com/watch?v=${it.id?.videoId}`} target="_blank" rel="noreferrer">
                Open
              </a>
              <button onClick={() => saveResult(it)} style={{ marginLeft: "auto" }}>
                Save
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
