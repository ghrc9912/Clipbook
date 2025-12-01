// src/DailymotionSearch.jsx
// Duplicate detection removed; auto-tagging retained.

import { useState } from "react";
import { db, auth } from "./firebase";
import { addDoc, collection } from "firebase/firestore";

export default function DailymotionSearch({ onSaved }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

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

  // simple keyword -> tag mapping (kept)
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
    };
    const tags = new Set();
    for (const [kw, tag] of Object.entries(map)) {
      if (text.includes(kw)) tags.add(tag);
    }
    if (tags.size === 0) tags.add("uncategorized");
    return Array.from(tags);
  };

  const saveResult = async (item) => {
    if (!auth.currentUser) return alert("Sign in first.");
    try {
      const watchUrl = item.url;
      const title = item.title;
      const desc = item.description;

      // Duplicate check removed — saving directly

      const tags = generateAutoTags(title, desc);

      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl: item.url,
        videoSite: "dailymotion",
        embedUrl: `https://www.dailymotion.com/embed/video/${item.id}?autoplay=0`,
        embedable: true,
        watchUrl: item.url,
        customTitle: item.title,
        description: item.description,
        playlistId: null,
        tags,
        autoTagsGenerated: true,
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
        <button onClick={search} disabled={loading}>
          {loading ? "Searching…" : "Search Dailymotion"}
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
