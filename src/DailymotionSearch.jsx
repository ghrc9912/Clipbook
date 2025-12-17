// src/DailymotionSearch.jsx
// Dailymotion search + AI auto-tagging (AI tags ON by default, checkbox hidden).
// Auto-tags limited to 3.

import { useState } from "react";
import { db, auth } from "./firebase";
import { addDoc, collection } from "firebase/firestore";

// short helper to truncate text
const truncate = (s, n = 1500) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

const normalizeTag = (t) => (t || "").toString().trim().toLowerCase();

// rule-based fallback tag mapping (kept) — now returns up to 3
const generateAutoTags = (title, desc) => {
  const text = `${title || ""} ${desc || ""}`.toLowerCase();
  const map = {
    tutorial: "tutorial",
    interview: "interview",
    music: "music",
    sports: "sports",
    lecture: "lecture",
    python: "python",
    react: "web-dev",
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

// AI tagger (calls HF/Groq proxy) — limit to 3
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

export default function DailymotionSearch({ onSaved }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [useAITags] = useState(true); // hidden toggle, default ON

  const search = async () => {
    if (!q) return;
    setLoading(true);
    try {
      const res = await fetch(
        `https://api.dailymotion.com/videos?search=${encodeURIComponent(q)}&limit=8&fields=id,title,description,thumbnail_url,url`
      );
      const data = await res.json();
      setResults(data.list || []);
    } catch (err) {
      console.error(err);
      alert("Dailymotion search failed. Check console.");
    } finally {
      setLoading(false);
    }
  };

  const saveResult = async (item) => {
    if (!auth.currentUser) return alert("Sign in first.");
    try {
      const watchUrl = item.url;
      const title = item.title;
      const desc = item.description;

      let tags = [];
      if (useAITags) {
        try {
          tags = await generateAITags(title, desc);
        } catch (err) {
          console.warn("AI tagging failed; using rule-based tags", err);
          tags = generateAutoTags(title, desc);
        }
      } else {
        tags = generateAutoTags(title, desc);
      }

      // finalize: normalize & limit 3
      tags = Array.from(new Set(tags.map(normalizeTag))).filter(Boolean).slice(0, 3);

      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl: item.url,
        videoSite: "dailymotion",
        embedUrl: `https://www.dailymotion.com/embed/video/${item.id}?autoplay=0`,
        embedable: true,
        watchUrl: item.url,
        customTitle: item.title,
        description: item.description,
        playlistIds: [],
        tags,
        autoTagsGenerated: !!useAITags,
        createdAt: Date.now(),
      });

      if (onSaved) onSaved();
      alert("Saved to ClipBook.");
    } catch (err) {
      console.error(err);
      alert("Dailymotion save failed. Check console.");
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <h3>Search Dailymotion</h3>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Dailymotion"
          style={{ flex: 1, padding: 8 }}
        />
        <button>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <img src="/dm-icon.png" width="18" alt="" />
          Search Dailymotion
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
          <div key={it.id} style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
            <img
              src={it.thumbnail_url}
              alt={it.title}
              style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 4 }}
            />
            <div style={{ fontWeight: "bold", marginTop: 6 }}>{it.title}</div>
            <div style={{ marginTop: 6, fontSize: 13, height: 48, overflow: "hidden" }}>{it.description}</div>
            <button onClick={() => saveResult(it)} style={{ marginTop: 8 }}>
              Save
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
