// src/YouTubeSearch.jsx
import { useState } from "react";
import { db, auth } from "./firebase";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";

/**
 * Simple YouTube search UI using YouTube Data API v3.
 * Requires VITE_YT_API_KEY in env.
 */
export default function YouTubeSearch({ onSaved }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const apiKey = import.meta.env.VITE_YT_API_KEY;

  const search = async () => {
    if (!q || !apiKey) return alert("Enter search term and ensure API key is set.");
    setLoading(true);
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error("YouTube API error: " + res.status + " " + text);
      }
      const data = await res.json();
      setResults(data.items || []);
    } catch (err) {
      console.error(err);
      alert("Search failed. Check console for details.");
    } finally {
      setLoading(false);
    }
  };

  // Save a result directly into Firestore as a clip (same shape as Dashboard expects)
  const saveResult = async (item) => {
    if (!auth.currentUser) return alert("Sign in first.");
    const videoId = item.id.videoId;
    const title = item.snippet.title;
    const desc = item.snippet.description;
    try {
      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        videoSite: "youtube",
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        embedable: true,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        customTitle: title,
        description: desc,
        playlistId: null,
        createdAt: Date.now()
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

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
        {results.map(it => (
          <div key={it.id.videoId} style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
            <img
              src={it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url}
              alt={it.snippet.title}
              style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 4 }}
            />
            <div style={{ fontWeight: "bold", marginTop: 6 }}>{it.snippet.title}</div>
            <div style={{ marginTop: 6, fontSize: 13, height: 48, overflow: "hidden", whiteSpace: "normal" }}>
              {it.snippet.description}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <a href={`https://www.youtube.com/watch?v=${it.id.videoId}`} target="_blank" rel="noreferrer">
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
