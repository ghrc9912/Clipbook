// src/DailymotionSearch.jsx
import { useState } from "react";
import { db, auth } from "./firebase";
import { addDoc, collection } from "firebase/firestore";

export default function DailymotionSearch() {
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

  const saveResult = async (item) => {
    if (!auth.currentUser) return alert("Sign in first.");
    try {
      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl: item.url,
        videoSite: "dailymotion",
        embedUrl: `https://www.dailymotion.com/embed/video/${item.id}?autoplay=0`,
        embedable: true,
        watchUrl: item.url,
        customTitle: item.title,
        description: item.description,
        playlistId: null,
        createdAt: Date.now(),
      });
      alert("Saved to ClipBook.");
    } catch (err) {
      console.error(err);
      alert("Save failed. Check console.");
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

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
        {results.map((it) => (
          <div key={it.id} style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
            <img src={it.thumbnail_url} alt={it.title} style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 4 }} />
            <div style={{ fontWeight: "bold", marginTop: 6 }}>{it.title}</div>
            <div style={{ marginTop: 6, fontSize: 13, height: 48, overflow: "hidden" }}>{it.description}</div>
            <button onClick={() => saveResult(it)} style={{ marginTop: 8 }}>Save</button>
          </div>
        ))}
      </div>
    </div>
  );
}
