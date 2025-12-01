// src/Dashboard.jsx
// Full final Dashboard with:
// - Duplicate detection
// - Auto-tags
// - Tag editing
// - Playlists
// - Export CSV
// - Data-science smart search recommendations (YouTube + Dailymotion)
// - Per-clip toggle: "Show Recommendations" / "Hide Recommendations"
// - Medium thumbnails (YouTube mqdefault, Dailymotion thumbnail_url)
// NOTE: Uses import.meta.env.VITE_YT_API_KEY for YouTube API key (do NOT hard-code keys)

import { useState, useEffect, useRef } from "react";
import { db, auth } from "./firebase";
import {
  collection,
  addDoc,
  onSnapshot,
  deleteDoc,
  doc,
  updateDoc,
  query,
  where,
  orderBy,
  getDocs,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import YouTubeSearch from "./YouTubeSearch";
import DailymotionSearch from "./DailymotionSearch";

/* ------------------------
   Utilities / small helpers
   ------------------------ */

function getEmbedInfo(rawUrl) {
  if (!rawUrl) return { site: "unknown", embedUrl: null, embedable: false, watchUrl: null };
  const url = rawUrl.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // YouTube
    if (host.includes("youtube.com") || host === "youtu.be") {
      const id = u.searchParams.get("v") || u.pathname.split("/")[1];
      if (id)
        return {
          site: "youtube",
          embedUrl: `https://www.youtube.com/embed/${id}`,
          embedable: true,
          watchUrl: `https://www.youtube.com/watch?v=${id}`,
        };
    }

    // Vimeo
    if (host.includes("vimeo.com")) {
      const id = u.pathname.split("/").filter(Boolean).pop();
      if (id)
        return {
          site: "vimeo",
          embedUrl: `https://player.vimeo.com/video/${id}`,
          embedable: true,
          watchUrl: `https://vimeo.com/${id}`,
        };
    }

    // Dailymotion
    if (host.includes("dailymotion.com") || host.includes("dai.ly")) {
      const id = u.pathname.split("/").filter(Boolean).pop();
      if (id)
        return {
          site: "dailymotion",
          embedUrl: `https://www.dailymotion.com/embed/video/${id}`,
          embedable: true,
          watchUrl: `https://${host}/video/${id}`,
        };
    }

    // Direct video file
    if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i))
      return { site: "file", embedUrl: url, embedable: true, watchUrl: url };

    return { site: host, embedUrl: url, embedable: false, watchUrl: url };
  } catch {
    return { site: "invalid", embedUrl: null, embedable: false, watchUrl: null };
  }
}

// tiny placeholder thumbnail (SVG data URL)
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%' height='100%' fill='#eee'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#777' font-size='16'>No thumbnail</text></svg>`
  );

/* ------------------------
   Basic tokenization for smart query (very small)
   ------------------------ */
const STOPWORDS = new Set([
  "the",
  "is",
  "in",
  "and",
  "to",
  "of",
  "a",
  "for",
  "with",
  "on",
  "by",
  "an",
  "be",
  "this",
  "that",
  "it",
  "as",
  "are",
  "at",
  "from",
  "or",
  "we",
  "you",
  "your",
]);

function extractKeywords(text, max = 8) {
  if (!text) return [];
  const words = String(text)
    .toLowerCase()
    .replace(/[\W_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w) && w.length > 2);

  // frequency
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  return sorted.slice(0, max);
}

/* ------------------------
   Smart query builder (data-science inspired)
   ------------------------ */
function buildSmartQuery({ title, tags = [], description }) {
  // priority: title tokens + tags + top description keywords
  const qParts = [];
  if (title) qParts.push(title);
  if (Array.isArray(tags) && tags.length) qParts.push(tags.slice(0, 4).join(" "));
  const descKeys = extractKeywords(description, 6);
  if (descKeys.length) qParts.push(descKeys.join(" "));
  // join and clean
  const q = qParts.join(" ").replace(/\s+/g, " ").trim();
  return q || ""; // empty string if nothing
}

/* ------------------------
   Recommendation API calls
   - YouTube: use search?q=QUERY (works always) and pick 3
   - Dailymotion: use videos?search=QUERY&limit=3
   ------------------------ */

async function fetchYouTubeRecommendations(queryStr, apiKey, maxResults = 3) {
  if (!queryStr) return [];
  if (!apiKey) {
    console.error("YouTube API key missing (import.meta.env.VITE_YT_API_KEY).");
    return [];
  }

  try {
    const url =
      "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=" +
      encodeURIComponent(maxResults) +
      "&q=" +
      encodeURIComponent(queryStr) +
      "&key=" +
      encodeURIComponent(apiKey);

    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      console.error("YouTube API returned", res.status, txt);
      return [];
    }
    const json = await res.json();
    if (!Array.isArray(json.items)) return [];
    // map to common shape
    return json.items.map((it) => {
      const videoId = it.id?.videoId;
      const snippet = it.snippet || {};
      const thumbnail =
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.default?.url ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null);
      return {
        id: videoId || `yt-${Math.random().toString(36).slice(2, 9)}`,
        title: snippet.title || "",
        description: snippet.description || "",
        watchUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        thumbnailUrl: thumbnail,
        source: "youtube",
      };
    });
  } catch (err) {
    console.error("YouTube fetch error", err);
    return [];
  }
}

async function fetchDailymotionRecommendations(queryStr, maxResults = 3) {
  if (!queryStr) return [];
  try {
    // Dailymotion search endpoint
    const url =
      "https://api.dailymotion.com/videos?fields=id,title,description,thumbnail_url,url&limit=" +
      encodeURIComponent(maxResults) +
      "&search=" +
      encodeURIComponent(queryStr);
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      console.error("Dailymotion API returned", res.status, txt);
      return [];
    }
    const json = await res.json();
    const list = json.list || json["list"] || json.data || [];
    return (list || []).map((it) => ({
      id: it.id,
      title: it.title || "",
      description: it.description || "",
      watchUrl: it.url || `https://www.dailymotion.com/video/${it.id}`,
      thumbnailUrl: it.thumbnail_url || null,
      source: "dailymotion",
    }));
  } catch (err) {
    console.error("Dailymotion fetch error", err);
    return [];
  }
}

/* ------------------------
   Main Dashboard component
   ------------------------ */

export default function Dashboard() {
  const [originalUrl, setOriginalUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [description, setDescription] = useState("");
  const [clips, setClips] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState("all");
  const [newPlaylistName, setNewPlaylistName] = useState("");

  // track recommendations UI state per clipId
  // { [clipId]: { visible: bool, loading: bool, results: [] } }
  const [recsState, setRecsState] = useState({});

  // ref to avoid repeated fetch when toggling quickly
  const recsCacheRef = useRef({}); // clipId -> results array

  const YT_API_KEY = import.meta.env.VITE_YT_API_KEY || null;

  // fetch playlists
  useEffect(() => {
    if (!auth.currentUser) return;
    const plRef = collection(db, "users", auth.currentUser.uid, "playlists");
    return onSnapshot(plRef, (snap) => {
      setPlaylists(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, []);

  // fetch clips (filter by playlist)
  useEffect(() => {
    if (!auth.currentUser) return;
    const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
    let q;
    if (selectedPlaylist !== "all") {
      q = query(clipsRef, where("playlistIds", "array-contains", selectedPlaylist), orderBy("createdAt", "desc"));
    } else {
      q = query(clipsRef, orderBy("createdAt", "desc"));
    }
    return onSnapshot(q, (snap) => {
      setClips(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [selectedPlaylist]);

  /* ------------------------
     Save / tags / duplicate detection
     ------------------------ */

  const generateAutoTags = (title, desc) => {
    const text = `${title || ""} ${desc || ""}`.toLowerCase();

    const map = {
      react: "web-dev",
      javascript: "web-dev",
      node: "web-dev",
      css: "web-dev",
      html: "web-dev",
      "machine learning": "machine-learning",
      "machine-learning": "machine-learning",
      ml: "machine-learning",
      neural: "machine-learning",
      "deep learning": "machine-learning",
      python: "python",
      pandas: "data-science",
      numpy: "data-science",
      "linear algebra": "math",
      calculus: "math",
      lecture: "lecture",
      tutorial: "tutorial",
      beginner: "beginner",
      advanced: "advanced",
    };

    const tags = new Set();
    for (const [kw, tag] of Object.entries(map)) {
      if (text.includes(kw)) tags.add(tag);
    }

    if (tags.size === 0) {
      if ((title || "").length < 30 && (desc || "").length < 80) tags.add("short");
      else tags.add("uncategorized");
    }

    return Array.from(tags);
  };

  const checkDuplicateByWatchUrl = async (watchUrl) => {
    if (!watchUrl) return false;
    try {
      const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
      const q = query(clipsRef, where("watchUrl", "==", watchUrl));
      const snap = await getDocs(q);
      return !snap.empty;
    } catch (err) {
      console.error("Duplicate check failed:", err);
      return false;
    }
  };

  const save = async () => {
    console.log("Dashboard.save called");
    if (!originalUrl) return alert("Paste a video link first");
    const info = getEmbedInfo(originalUrl);
    if (info.site === "invalid") return alert("Invalid URL");

    const normalizedWatchUrl = info.watchUrl || originalUrl;

    // 1) Duplicate detection
    const isDup = await checkDuplicateByWatchUrl(normalizedWatchUrl);
    if (isDup) {
      return alert("This clip (or a very similar one) already exists in your ClipBook.");
    }

    // 2) Auto-tags generation
    const autoTags = generateAutoTags(customTitle || "", description || "");

    // Build thumbnail if possible for manual paste saves (YouTube)
    let thumbnailUrl = null;
    try {
      if (info.site === "youtube") {
        const id = info.watchUrl?.split("v=")[1] || null;
        if (id) thumbnailUrl = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      }
    } catch (e) {
      thumbnailUrl = null;
    }

    try {
      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl,
        videoSite: info.site,
        embedUrl: info.embedUrl || null,
        embedable: !!info.embedable,
        watchUrl: info.watchUrl || originalUrl,
        customTitle: customTitle || null,
        description: description || null,
        playlistIds: [],
        tags: autoTags,
        autoTagsGenerated: true,
        thumbnailUrl: thumbnailUrl || null,
        createdAt: Date.now(),
      });
      setOriginalUrl("");
      setCustomTitle("");
      setDescription("");
    } catch (err) {
      console.error("Save failed:", err);
      alert("Could not save clip. See console.");
    }
  };

  /* ------------------------
     Export CSV (same as before)
     ------------------------ */

  const exportClipsCSV = async () => {
    if (!auth.currentUser) return alert("Sign in first to export clips.");
    try {
      const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
      const snap = await getDocs(query(clipsRef, orderBy("createdAt", "desc")));
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (!docs.length) return alert("No clips to export.");

      const rows = [];
      rows.push([
        "id",
        "customTitle",
        "description",
        "watchUrl",
        "originalUrl",
        "videoSite",
        "tags",
        "playlistIds",
        "thumbnailUrl",
        "autoTagsGenerated",
        "createdAt",
      ]);

      for (const d of docs) {
        rows.push([
          d.id || "",
          (d.customTitle || "").replace(/\r?\n|\r/g, " "),
          (d.description || "").replace(/\r?\n|\r/g, " "),
          d.watchUrl || "",
          d.originalUrl || "",
          d.videoSite || "",
          Array.isArray(d.tags) ? d.tags.join("|") : "",
          Array.isArray(d.playlistIds) ? d.playlistIds.join("|") : "",
          d.thumbnailUrl || "",
          d.autoTagsGenerated ? "true" : "false",
          d.createdAt ? new Date(d.createdAt).toISOString() : "",
        ]);
      }

      const csv = rows
        .map((row) =>
          row
            .map((cell) => {
              if (cell === null || cell === undefined) return "";
              const s = String(cell).replace(/"/g, '""');
              if (/[,"\n]/.test(s)) return `"${s}"`;
              return s;
            })
            .join(",")
        )
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const uidShort = auth.currentUser?.uid ? auth.currentUser.uid.slice(0, 8) : "user";
      a.download = `clipbook_export_${uidShort}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      alert("Export started — check your downloads folder.");
    } catch (err) {
      console.error("Export failed:", err);
      alert("Export failed. See console for details.");
    }
  };

  /* ------------------------
     Clip helpers (edit/delete/tags/playlist)
     ------------------------ */

  const deleteClip = async (id) => {
    if (!auth.currentUser) return;
    try {
      await deleteDoc(doc(db, "users", auth.currentUser.uid, "clips", id));
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Could not delete clip. Check console.");
    }
  };

  const editClip = async (clip) => {
    const newTitle = prompt("Edit title (leave blank to clear):", clip.customTitle || "");
    if (newTitle === null) return;
    const newDesc = prompt("Edit description (optional):", clip.description || "");
    if (newDesc === null) return;
    try {
      const docRef = doc(db, "users", auth.currentUser.uid, "clips", clip.id);
      await updateDoc(docRef, { customTitle: newTitle || null, description: newDesc || null });
      setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, customTitle: newTitle || null, description: newDesc || null } : c)));
    } catch (err) {
      console.error("Edit failed:", err);
    }
  };

  const editTags = async (clip) => {
    const current = Array.isArray(clip.tags) ? clip.tags.join(", ") : "";
    const raw = prompt("Edit tags (comma-separated). Example: data-science, tutorial", current);
    if (raw === null) return;
    const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      const docRef = doc(db, "users", auth.currentUser.uid, "clips", clip.id);
      await updateDoc(docRef, { tags, autoTagsGenerated: false });
      setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, tags, autoTagsGenerated: false } : c)));
    } catch (err) {
      console.error("Edit tags failed:", err);
      alert("Could not update tags. See console.");
    }
  };

  const toggleClipPlaylist = async (clipId, plId, add) => {
    if (!auth.currentUser) return;
    try {
      const docRef = doc(db, "users", auth.currentUser.uid, "clips", clipId);
      if (add) await updateDoc(docRef, { playlistIds: arrayUnion(plId) });
      else await updateDoc(docRef, { playlistIds: arrayRemove(plId) });

      setClips((prev) =>
        prev.map((c) => {
          if (c.id !== clipId) return c;
          const ids = new Set(c.playlistIds || []);
          if (add) ids.add(plId);
          else ids.delete(plId);
          return { ...c, playlistIds: Array.from(ids) };
        })
      );
    } catch (err) {
      console.error("Toggle playlist failed:", err);
      alert("Could not update playlist. See console.");
    }
  };

  const createPlaylist = async () => {
    const name = newPlaylistName.trim();
    if (!name) return alert("Enter playlist name");
    try {
      await addDoc(collection(db, "users", auth.currentUser.uid, "playlists"), {
        name,
        createdAt: Date.now(),
      });
      setNewPlaylistName("");
    } catch (err) {
      console.error("Create playlist failed:", err);
    }
  };

  const deletePlaylist = async (plId) => {
    if (!confirm("Delete this playlist? Clips will remain but be moved to 'None'.")) return;
    try {
      await deleteDoc(doc(db, "users", auth.currentUser.uid, "playlists", plId));
      const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
      const q = query(clipsRef, where("playlistIds", "array-contains", plId));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        await updateDoc(d.ref, { playlistIds: arrayRemove(plId) });
      }
      if (selectedPlaylist === plId) setSelectedPlaylist("all");
    } catch (err) {
      console.error("Delete playlist failed:", err);
    }
  };

  const shareClip = async (c) => {
    const watch = c.watchUrl || c.originalUrl || c.embedUrl;
    const payload = `${watch}\n\nTitle: ${c.customTitle || ""}\n\n${c.description || ""}\n\nShared from ClipBook`;
    try {
      await navigator.clipboard.writeText(payload);
      alert("Copied share text to clipboard!");
    } catch {
      alert("Could not copy. Here's the link: " + watch);
    }
  };

  /* ------------------------
     Recommendation: toggle & fetch
     ------------------------ */

  const toggleRecommendations = async (clip) => {
    // clip: object
    if (!clip || !clip.id) return;
    const cid = clip.id;
    const state = recsState[cid] || { visible: false, loading: false, results: [] };
    // if currently visible -> hide
    if (state.visible) {
      setRecsState((prev) => ({ ...prev, [cid]: { ...state, visible: false } }));
      return;
    }

    // if cached already -> show cached
    if (recsCacheRef.current[cid]) {
      setRecsState((prev) => ({ ...prev, [cid]: { visible: true, loading: false, results: recsCacheRef.current[cid] } }));
      return;
    }

    // else fetch recommendations
    setRecsState((prev) => ({ ...prev, [cid]: { visible: true, loading: true, results: [] } }));

    // build smart query
    const qStr = buildSmartQuery({ title: clip.customTitle || clip.description || "", tags: clip.tags || [], description: clip.description || "" });

    // prefer platform of the clip to search on same platform first
    const results = [];
    try {
      if (clip.videoSite === "youtube") {
        // YouTube search (smart query)
        const ytRes = await fetchYouTubeRecommendations(qStr, YT_API_KEY, 4);
        // remove if same video (matching watchUrl) and limit to 3
        const filtered = ytRes.filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3);
        results.push(...filtered);
        // fallback: if not enough, call Dailymotion
        if (results.length < 3) {
          const dmRes = await fetchDailymotionRecommendations(qStr, 3);
          const more = dmRes.filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3 - results.length);
          results.push(...more);
        }
      } else if (clip.videoSite === "dailymotion") {
        const dmRes = await fetchDailymotionRecommendations(qStr, 4);
        const filtered = dmRes.filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3);
        results.push(...filtered);
        if (results.length < 3) {
          const ytRes = await fetchYouTubeRecommendations(qStr, YT_API_KEY, 3);
          const more = ytRes.filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3 - results.length);
          results.push(...more);
        }
      } else {
        // unknown: call both and combine
        const [ytRes, dmRes] = await Promise.all([fetchYouTubeRecommendations(qStr, YT_API_KEY, 3), fetchDailymotionRecommendations(qStr, 3)]);
        const both = [...ytRes, ...dmRes].filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3);
        results.push(...both);
      }
    } catch (err) {
      console.error("Recommendation fetch error", err);
    }

    // save to cache and state
    recsCacheRef.current[cid] = results;
    setRecsState((prev) => ({ ...prev, [cid]: { visible: true, loading: false, results } }));
  };

  /* ------------------------
     Render
     ------------------------ */

  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1>ClipBook</h1>
        <div>
          <span style={{ marginRight: 8 }}>{auth.currentUser?.displayName}</span>
          <button
            onClick={async () => {
              try {
                await auth.signOut();
              } catch (err) {
                console.error("Sign-out failed:", err);
              }
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <section style={{ marginBottom: 16 }}>
        <YouTubeSearch onSaved={() => {}} />
        <DailymotionSearch onSaved={() => {}} />

        <label>Video link:</label>
        <input
          value={originalUrl}
          onChange={(e) => setOriginalUrl(e.target.value)}
          placeholder="Paste video link"
          style={{ width: "100%", padding: 8, marginBottom: 8 }}
        />

        <label>Custom title:</label>
        <input
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
          style={{ width: "100%", padding: 8, marginBottom: 8 }}
        />

        <label>Description / notes:</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: "100%", padding: 8, marginBottom: 8, minHeight: 60 }}
        />

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={save}
            style={{ background: "#1a73e8", color: "white", padding: "8px 14px", border: "none", borderRadius: 6 }}
          >
            Save Clip
          </button>

          <button onClick={exportClipsCSV} style={{ marginLeft: 10, padding: "8px 14px", borderRadius: 6 }}>
            Export Clips (CSV)
          </button>
        </div>
      </section>

      <section style={{ display: "flex", gap: 20 }}>
        <aside style={{ minWidth: 220 }}>
          <h3>Playlists</h3>
          <button onClick={() => setSelectedPlaylist("all")} style={{ marginBottom: 6 }}>
            All
          </button>

          {playlists.map((pl) => (
            <div key={pl.id} style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setSelectedPlaylist(pl.id)} style={{ background: selectedPlaylist === pl.id ? "#ddd" : "transparent" }}>
                {pl.name}
              </button>
              <button onClick={() => deletePlaylist(pl.id)} style={{ border: "none", background: "transparent", color: "red" }}>
                ✖
              </button>
            </div>
          ))}

          <div style={{ marginTop: 12 }}>
            <input placeholder="New playlist name" value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)} style={{ width: "100%", padding: 6 }} />
            <button onClick={createPlaylist} style={{ marginTop: 6 }}>
              Create Playlist
            </button>
          </div>
        </aside>

        <main style={{ flex: 1 }}>
          <h3>
            {selectedPlaylist === "all" ? "All Clips" : `Clips in: ${playlists.find((p) => p.id === selectedPlaylist)?.name || "Selected"}`}
          </h3>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {clips.map((c) => {
              const state = recsState[c.id] || { visible: false, loading: false, results: [] };
              return (
                <div key={c.id} style={{ width: 360, border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
                  {c.embedable && c.embedUrl ? (
                    c.videoSite === "file" ? (
                      <video width="340" height="200" controls src={c.embedUrl} />
                    ) : (
                      <iframe
                        width="340"
                        height="200"
                        src={c.embedUrl}
                        title={c.customTitle || "video"}
                        frameBorder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    )
                  ) : (
                    <a href={c.watchUrl || c.originalUrl} target="_blank" rel="noreferrer">
                      Open video
                    </a>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: "bold" }}>{c.customTitle || "No title"}</div>
                    <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{c.description}</div>

                    {/* Tags */}
                    {Array.isArray(c.tags) && c.tags.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ fontSize: 13, marginBottom: 6 }}>Tags:</div>
                          <button
                            onClick={() => editTags(c)}
                            style={{
                              fontSize: 12,
                              padding: "4px 8px",
                              borderRadius: 8,
                              border: "1px solid #ccc",
                              background: "white",
                              cursor: "pointer",
                            }}
                          >
                            Edit
                          </button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {c.tags.map((t) => (
                            <span
                              key={t}
                              style={{
                                background: "#eef2ff",
                                color: "#1a237e",
                                padding: "4px 8px",
                                borderRadius: 12,
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Playlists */}
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 13, marginBottom: 4 }}>Playlists:</div>
                      {playlists.map((pl) => {
                        const checked = Array.isArray(c.playlistIds) && c.playlistIds.includes(pl.id);
                        return (
                          <label key={pl.id} style={{ display: "inline-flex", alignItems: "center", marginRight: 8 }}>
                            <input type="checkbox" checked={checked} onChange={(e) => toggleClipPlaylist(c.id, pl.id, e.target.checked)} />
                            <span style={{ marginLeft: 6 }}>{pl.name}</span>
                          </label>
                        );
                      })}
                    </div>

                    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                      <button onClick={() => editClip(c)}>Edit</button>
                      <button onClick={() => deleteClip(c.id)} style={{ background: "#e53935", color: "white" }}>
                        Delete
                      </button>
                      <button onClick={() => shareClip(c)}>Share</button>
                    </div>

                    {/* Recommendation toggle */}
                    <div style={{ marginTop: 12 }}>
                      <button
                        onClick={() => toggleRecommendations(c)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 6,
                          border: "1px solid #ccc",
                          background: state.visible ? "#f5f5f5" : "white",
                          cursor: "pointer",
                          fontWeight: 600,
                        }}
                      >
                        {state.visible ? "Hide Recommendations" : "Show Recommendations"}
                      </button>
                    </div>

                    {/* Recommendations block */}
                    {state.visible && (
                      <div style={{ marginTop: 10 }}>
                        {state.loading ? (
                          <div style={{ color: "#666", fontSize: 13 }}>Loading recommendations…</div>
                        ) : state.results && state.results.length > 0 ? (
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            {state.results.map((r) => (
                              <a
                                key={r.id}
                                href={r.watchUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  width: 160,
                                  textDecoration: "none",
                                  color: "inherit",
                                  border: "1px solid #f0f0f0",
                                  padding: 6,
                                  borderRadius: 6,
                                  background: "#fff",
                                }}
                              >
                                <img
                                  src={r.thumbnailUrl || PLACEHOLDER_THUMB}
                                  alt={r.title}
                                  style={{ width: "100%", height: 90, objectFit: "cover", borderRadius: 4 }}
                                />
                                <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.15, fontWeight: 600 }}>{r.title}</div>
                                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                                  {r.source === "youtube" ? "YouTube" : r.source === "dailymotion" ? "Dailymotion" : ""}
                                </div>
                              </a>
                            ))}
                          </div>
                        ) : (
                          <div style={{ color: "#666", fontSize: 13 }}>No recommendations found.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </main>
      </section>
    </div>
  );
}
