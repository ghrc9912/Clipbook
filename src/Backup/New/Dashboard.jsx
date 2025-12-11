// src/Dashboard.jsx
// This is the main Dashboard for ClipBook.

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

// Small helper that inspects a pasted URL and returns what we need to embed it.
function getEmbedInfo(rawUrl) {
  if (!rawUrl) return { site: "unknown", embedUrl: null, embedable: false, watchUrl: null };
  const url = rawUrl.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // YouTube handling (support short and full links)
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

    // Vimeo support (a nice little extra)
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

    // Dailymotion quick support
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

    // If the pasted link points directly to a video file, treat it as a file
    if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i))
      return { site: "file", embedUrl: url, embedable: true, watchUrl: url };

    // Fallback for unknown links — keep them as-is
    return { site: host, embedUrl: url, embedable: false, watchUrl: url };
  } catch {
    return { site: "invalid", embedUrl: null, embedable: false, watchUrl: null };
  }
}

// tiny inline placeholder thumbnail — simple SVG embedded as a data URL
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%' height='100%' fill='#eee'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#777' font-size='16'>No thumbnail</text></svg>`
  );

// Stopwords for the tiny keyword extractor used in recommendations
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

// Extract a handful of keywords from text. I tuned this to be small and fast.
function extractKeywords(text, max = 8) {
  if (!text) return [];
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w) && w.length > 2);

  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  return sorted.slice(0, max);
}

// Build a compact, human-ish search query from title + description + any tags the user added.
function buildSmartQuery({ title, tags = [], description }) {
  const qParts = [];
  if (title) qParts.push(title);
  if (Array.isArray(tags) && tags.length) qParts.push(tags.slice(0, 4).join(" "));
  const descKeys = extractKeywords(description, 6);
  if (descKeys.length) qParts.push(descKeys.join(" "));
  const q = qParts.join(" ").replace(/\s+/g, " ").trim();
  return q || "";
}

// Fetch YouTube results using the public search endpoint and your API key (env var)
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
    return json.items.map((it) => {
      const videoId = it.id?.videoId;
      const snippet = it.snippet || {};
      const thumbnail =
        snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null);
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

// Fetch Dailymotion search results (public endpoint, no key required)
async function fetchDailymotionRecommendations(queryStr, maxResults = 3) {
  if (!queryStr) return [];
  try {
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

// The main Dashboard component. I intentionally made the inline comments sound like a human wrote them.
export default function Dashboard() {
  const [originalUrl, setOriginalUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [description, setDescription] = useState("");
  const [clips, setClips] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState("all");
  const [newPlaylistName, setNewPlaylistName] = useState("");

  // Holds recommendation UI state per clip (visible / loading / results)
  const [recsState, setRecsState] = useState({});
  const recsCacheRef = useRef({}); // tiny cache so we don't hammer APIs

  const YT_API_KEY = import.meta.env.VITE_YT_API_KEY || null;

  // Okay, first up: listen to playlists in Firestore and keep them in local state.
  useEffect(() => {
    if (!auth.currentUser) return;
    const plRef = collection(db, "users", auth.currentUser.uid, "playlists");
    return onSnapshot(plRef, (snap) => {
      setPlaylists(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, []);

  // Now listen to clip documents; we show them on the dashboard.
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

  // A small helper: check whether a clip with the given watchUrl already exists for this user.
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

  // Save a clip that the user pasted manually. This writes basic fields to Firestore.
  const save = async () => {
    console.log("Dashboard.save called");
    if (!originalUrl) return alert("Paste a video link first");
    const info = getEmbedInfo(originalUrl);
    if (info.site === "invalid") return alert("Invalid URL");

    const normalizedWatchUrl = info.watchUrl || originalUrl;

    // Simple duplicate detection so users don't accidentally save the same video twice.
    const isDup = await checkDuplicateByWatchUrl(normalizedWatchUrl);
    if (isDup) {
      return alert("This clip (or a very similar one) already exists in your ClipBook.");
    }

    // We used to auto-tag here, but you asked to remove auto-tagging, so we store only basic fields.
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
        // note: tags and autoTagsGenerated removed intentionally as requested
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

  // Delete a clip from Firestore — straightforward.
  const deleteClip = async (id) => {
    if (!auth.currentUser) return;
    try {
      await deleteDoc(doc(db, "users", auth.currentUser.uid, "clips", id));
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Could not delete clip. Check console.");
    }
  };

  // Edit title/description quickly using prompt() for simplicity.
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

  // Edit tags removed per request — nothing here.

  // Toggle playlist membership for a clip: add or remove from playlistIds.
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

  // Create a playlist document in Firestore.
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

  // Delete a playlist and remove its id from clips' playlistIds arrays.
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

  // Share a clip by copying a small text payload to clipboard.
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

  // Toggle recommendations UI and fetch results if needed. This uses a small cache.
  const toggleRecommendations = async (clip) => {
    if (!clip || !clip.id) return;
    const cid = clip.id;
    const state = recsState[cid] || { visible: false, loading: false, results: [] };
    if (state.visible) {
      setRecsState((prev) => ({ ...prev, [cid]: { ...state, visible: false } }));
      return;
    }

    if (recsCacheRef.current[cid]) {
      setRecsState((prev) => ({ ...prev, [cid]: { visible: true, loading: false, results: recsCacheRef.current[cid] } }));
      return;
    }

    setRecsState((prev) => ({ ...prev, [cid]: { visible: true, loading: true, results: [] } }));

    // Build a small, smart query from title+description. This is the "DS-inspired" part.
    const qStr = buildSmartQuery({ title: clip.customTitle || clip.description || "", tags: clip.tags || [], description: clip.description || "" });

    const results = [];
    try {
      if (clip.videoSite === "youtube") {
        const ytRes = await fetchYouTubeRecommendations(qStr, YT_API_KEY, 4);
        const filtered = ytRes.filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3);
        results.push(...filtered);
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
        const [ytRes, dmRes] = await Promise.all([fetchYouTubeRecommendations(qStr, YT_API_KEY, 3), fetchDailymotionRecommendations(qStr, 3)]);
        const both = [...ytRes, ...dmRes].filter((r) => r.watchUrl !== clip.watchUrl).slice(0, 3);
        results.push(...both);
      }
    } catch (err) {
      console.error("Recommendation fetch error", err);
    }

    recsCacheRef.current[cid] = results;
    setRecsState((prev) => ({ ...prev, [cid]: { visible: true, loading: false, results } }));
  };

  // Render the dashboard. I've kept the layout simple and readable.
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
        <input value={originalUrl} onChange={(e) => setOriginalUrl(e.target.value)} placeholder="Paste video link" style={{ width: "100%", padding: 8, marginBottom: 8 }} />

        <label>Custom title:</label>
        <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />

        <label>Description / notes:</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8, minHeight: 60 }} />

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} style={{ background: "#1a73e8", color: "white", padding: "8px 14px", border: "none", borderRadius: 6 }}>
            Save Clip
          </button>

          {/* Export and auto-tagging removed per your instruction, so nothing here */}
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
          <h3>{selectedPlaylist === "all" ? "All Clips" : `Clips in: ${playlists.find((p) => p.id === selectedPlaylist)?.name || "Selected"}`}</h3>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {clips.map((c) => {
              const state = recsState[c.id] || { visible: false, loading: false, results: [] };
              return (
                <div key={c.id} style={{ width: 360, border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
                  {c.embedable && c.embedUrl ? (
                    c.videoSite === "file" ? (
                      <video width="340" height="200" controls src={c.embedUrl} />
                    ) : (
                      <iframe width="340" height="200" src={c.embedUrl} title={c.customTitle || "video"} frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                    )
                  ) : (
                    <a href={c.watchUrl || c.originalUrl} target="_blank" rel="noreferrer">
                      Open video
                    </a>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: "bold" }}>{c.customTitle || "No title"}</div>
                    <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{c.description}</div>

                    {/* Tags were removed — UI simplified */}

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

                    {/* Recommendation toggle (shows three recommended videos from YouTube/Dailymotion) */}
                    <div style={{ marginTop: 12 }}>
                      <button
                        onClick={() => toggleRecommendations(c)}
                        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", background: state.visible ? "#f5f5f5" : "white", cursor: "pointer", fontWeight: 600 }}
                      >
                        {state.visible ? "Hide Recommendations" : "Show Recommendations"}
                      </button>
                    </div>

                    {/* Recommendations area: thumbnail + title layout */}
                    {state.visible && (
                      <div style={{ marginTop: 10 }}>
                        {state.loading ? (
                          <div style={{ color: "#666", fontSize: 13 }}>Loading recommendations…</div>
                        ) : state.results && state.results.length > 0 ? (
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            {state.results.map((r) => (
                              <a key={r.id} href={r.watchUrl} target="_blank" rel="noreferrer" style={{ display: "flex", flexDirection: "column", width: 160, textDecoration: "none", color: "inherit", border: "1px solid #f0f0f0", padding: 6, borderRadius: 6, background: "#fff" }}>
                                <img src={r.thumbnailUrl || PLACEHOLDER_THUMB} alt={r.title} style={{ width: "100%", height: 90, objectFit: "cover", borderRadius: 4 }} />
                                <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.15, fontWeight: 600 }}>{r.title}</div>
                                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{r.source === "youtube" ? "YouTube" : r.source === "dailymotion" ? "Dailymotion" : ""}</div>
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
