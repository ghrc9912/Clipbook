// src/YouTubeSearch.jsx
// Duplicate detection removed; auto-tagging retained.

import { useState } from "react";
import { db, auth } from "./firebase";
import {
  addDoc,
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";

export default function YouTubeSearch({ onSaved }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
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

      console.log("YouTube search url:", url);
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

  // Auto-tag generator (kept)
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
    };
    const tags = new Set();
    for (const [kw, tag] of Object.entries(map)) {
      if (text.includes(kw)) tags.add(tag);
    }
    if (tags.size === 0) tags.add("uncategorized");
    return Array.from(tags);
  };

  const saveResult = async (item) => {
    console.log("YouTubeSearch.saveResult called");
    if (!auth.currentUser) return alert("Sign in first.");

    const videoId = item.id?.videoId || (item.id && item.id.videoId) || null;
    if (!videoId) return alert("Invalid video item.");

    const title = item.snippet?.title || "";
    const desc = item.snippet?.description || "";
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Duplicate check removed — saving directly

    const autoTags = generateAutoTags(title, desc);

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
        autoTagsGenerated: true,
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
        <button onClick={search} disabled={loading} style={{ padding: "8px 12px" }}>
          {loading ? "Searching…" : "Search YouTube"}
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
