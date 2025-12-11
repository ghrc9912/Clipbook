// src/Dashboard.jsx
// Dashboard with per-clip three-dot menu (⋯) opening a popover under the video clip.
// Popovers are hidden by default and open when the menu is clicked.
// Removed the global "Filtering by tag" block as requested.

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
  getDocs,
  arrayUnion,
  arrayRemove,
  orderBy,
  where,
} from "firebase/firestore";
import YouTubeSearch from "./YouTubeSearch";
import DailymotionSearch from "./DailymotionSearch";
import ChatAI_HF from "./ChatAI_HF";

// helpers
const truncate = (s, n = 1500) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const normalizeTag = (t) => (t || "").toString().trim().toLowerCase();

// color helpers (unchanged)
const TAG_COLOR_MAP = {
  python: "#2b6cb0",
  "data-science": "#2b6cb0",
  "machine-learning": "#2b6cb0",
  pandas: "#2b6cb0",
  "web-dev": "#2563eb",
  javascript: "#f59e0b",
  react: "#60a5fa",
  tutorial: "#0ea5a4",
  gaming: "#10b981",
  music: "#8b5cf6",
  nature: "#14b8a6",
  college: "#f97316",
  lecture: "#f97316",
  uncategorized: "#94a3b8",
};
const fallbackColor = (tag) => {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h << 5) - h + tag.charCodeAt(i);
  const colors = ["#60a5fa", "#34d399", "#f472b6", "#fb923c", "#a78bfa", "#f59e0b", "#94a3b8"];
  return colors[Math.abs(h) % colors.length];
};
const tagColor = (t) => TAG_COLOR_MAP[normalizeTag(t)] || fallbackColor(normalizeTag(t));

// small AI tag generator used on manual save (unchanged)
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

// fallback rule-based tag generator (keeps up to 3)
const generateAutoTagsFallback = (title, desc) => {
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

export default function Dashboard() {
  // base state
  const [originalUrl, setOriginalUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [description, setDescription] = useState("");
  const [clips, setClips] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState("all");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [chatVisible, setChatVisible] = useState(false);

  // tag UI state
  const [selectedTagFilter, setSelectedTagFilter] = useState(null);
  const [editingTagForClip, setEditingTagForClip] = useState(null);
  const [newTagInputForClip, setNewTagInputForClip] = useState({});

  // visibility toggles (session)
  const [showTags, setShowTags] = useState(true);
  const [showAddTagBar, setShowAddTagBar] = useState(true);
  const [showTagCloud, setShowTagCloud] = useState(true);

  // per-clip popover open state (default hidden)
  // popoverOpen: { [clipId]: boolean } -> true = open
  const [popoverOpen, setPopoverOpen] = useState({});

  // reference to container to handle outside clicks
  const containerRef = useRef(null);

  useEffect(() => {
    if (!auth.currentUser) return;
    const plRef = collection(db, "users", auth.currentUser.uid, "playlists");
    return onSnapshot(plRef, (snap) => {
      setPlaylists(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, []);

  useEffect(() => {
    if (!auth.currentUser) return;
    const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
    const q = query(clipsRef, orderBy("createdAt", "desc"));
    return onSnapshot(q, (snap) => {
      setClips(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, []);

  // close all popovers on outside click
  useEffect(() => {
    const onDocClick = (e) => {
      // if click inside containerRef and target is a menu button or popover, don't close
      const inside = containerRef.current && containerRef.current.contains(e.target);
      if (!inside) {
        // clicked outside the whole dashboard; close all
        setPopoverOpen({});
        return;
      }
      // If clicked an element with data-popover-ignore attribute, keep open
      const ignore = e.target.closest && e.target.closest("[data-popover-ignore]");
      if (ignore) return;
      // Otherwise close all popovers
      setPopoverOpen({});
    };
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, []);

  // toggle single popover; prevent closing by global click (we mark the button/popover with data-popover-ignore)
  const togglePopover = (clipId, e) => {
    e && e.stopPropagation();
    setPopoverOpen((prev) => ({ ...prev, [clipId]: !prev[clipId] }));
  };

  // manual save
  const save = async () => {
    if (!originalUrl) return alert("Paste a video link first");

    const getEmbedInfo = (rawUrl) => {
      if (!rawUrl) return { site: "unknown", embedUrl: null, embedable: false, watchUrl: null };
      const url = rawUrl.trim();
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();

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
        if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i))
          return { site: "file", embedUrl: url, embedable: true, watchUrl: url };
        return { site: host, embedUrl: url, embedable: false, watchUrl: url };
      } catch {
        return { site: "invalid", embedUrl: null, embedable: false, watchUrl: null };
      }
    };

    const info = getEmbedInfo(originalUrl);
    if (info.site === "invalid") return alert("Invalid URL");

    let thumbnailUrl = null;
    try {
      if (info.site === "youtube") {
        const id = info.watchUrl?.split("v=")[1] || null;
        if (id) thumbnailUrl = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      }
    } catch (e) {
      thumbnailUrl = null;
    }

    let tagsToSave = [];
    try {
      tagsToSave = await generateAITags(customTitle || info.watchUrl || originalUrl, description || "");
    } catch (err) {
      tagsToSave = generateAutoTagsFallback(customTitle || "", description || "");
    }
    tagsToSave = Array.from(new Set((tagsToSave || []).map(normalizeTag))).filter(Boolean).slice(0, 3);

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
        thumbnailUrl: thumbnailUrl || null,
        tags: tagsToSave,
        autoTagsGenerated: true,
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

  // tags operations
  const addTagToClip = async (clipId, tagValue) => {
    const tag = normalizeTag(tagValue);
    if (!tag) return;
    try {
      const clipDoc = doc(db, "users", auth.currentUser.uid, "clips", clipId);
      const clip = clips.find((c) => c.id === clipId);
      const currentTags = Array.isArray(clip?.tags) ? clip.tags.map(normalizeTag) : [];
      if (currentTags.includes(tag)) {
        setNewTagInputForClip((s) => ({ ...s, [clipId]: "" }));
        return;
      }
      if (currentTags.length >= 3) {
        alert("Maximum 3 tags allowed per clip.");
        return;
      }
      await updateDoc(clipDoc, { tags: arrayUnion(tag) });
      setNewTagInputForClip((s) => ({ ...s, [clipId]: "" }));
    } catch (err) {
      console.error("Add tag failed:", err);
      alert("Could not add tag. See console.");
    }
  };

  const deleteTagFromClip = async (clipId, tagToRemove) => {
    try {
      const clipDoc = doc(db, "users", auth.currentUser.uid, "clips", clipId);
      await updateDoc(clipDoc, { tags: arrayRemove(tagToRemove) });
      if (selectedTagFilter && normalizeTag(selectedTagFilter) === normalizeTag(tagToRemove)) setSelectedTagFilter(null);
    } catch (err) {
      console.error("Delete tag failed:", err);
      alert("Could not delete tag. See console.");
    }
  };

  const replaceTagOnClip = async (clipId, oldTag, newTagRaw) => {
    const newTag = normalizeTag(newTagRaw);
    if (!newTag) return;
    try {
      const clipDoc = doc(db, "users", auth.currentUser.uid, "clips", clipId);
      const clip = clips.find((c) => c.id === clipId);
      const currentTags = Array.isArray(clip?.tags) ? clip.tags.map(normalizeTag) : [];
      if (currentTags.includes(newTag)) {
        await updateDoc(clipDoc, { tags: arrayRemove(oldTag) });
        setEditingTagForClip(null);
        return;
      }
      if (currentTags.length >= 3 && !currentTags.includes(oldTag)) {
        alert("Cannot replace — clip already has 3 tags.");
        return;
      }
      await updateDoc(clipDoc, { tags: arrayRemove(oldTag) });
      await updateDoc(clipDoc, { tags: arrayUnion(newTag) });
      setEditingTagForClip(null);
    } catch (err) {
      console.error("Replace tag failed:", err);
      alert("Could not edit tag. See console.");
    }
  };

  // filtering and tag cloud
  const visibleClips = clips.filter((c) => {
    if (selectedPlaylist !== "all") {
      const has = Array.isArray(c.playlistIds) && c.playlistIds.includes(selectedPlaylist);
      if (!has) return false;
    }
    if (selectedTagFilter) {
      const t = normalizeTag(selectedTagFilter);
      const hasTag = Array.isArray(c.tags) && c.tags.map(normalizeTag).includes(t);
      if (!hasTag) return false;
    }
    return true;
  });

  const tagCounts = visibleClips.reduce((acc, c) => {
    const tarr = Array.isArray(c.tags) ? c.tags : [];
    for (const t of tarr) {
      const k = normalizeTag(t);
      if (!k) continue;
      acc[k] = (acc[k] || 0) + 1;
    }
    return acc;
  }, {});

  // UI helpers
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
    } catch (err) {
      console.error("Edit failed:", err);
    }
  };

  const toggleClipPlaylist = async (clipId, plId, add) => {
    if (!auth.currentUser) return;
    try {
      const docRef = doc(db, "users", auth.currentUser.uid, "clips", clipId);
      if (add) await updateDoc(docRef, { playlistIds: arrayUnion(plId) });
      else await updateDoc(docRef, { playlistIds: arrayRemove(plId) });
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

  const clearTagFilter = () => setSelectedTagFilter(null);

  // Small styling helpers used inline below:
  const smallBtn = (isActive) => ({
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ddd",
    background: isActive ? "#e6eefc" : "white",
    cursor: "pointer",
    fontSize: 13,
  });

  return (
    <div ref={containerRef} style={{ padding: 12 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ClipBook</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={showTags} onChange={() => setShowTags((s) => !s)} /> Show Tags
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={showAddTagBar} onChange={() => setShowAddTagBar((s) => !s)} /> Show Add Tag Bar
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={showTagCloud} onChange={() => setShowTagCloud((s) => !s)} /> Show Tag Cloud
          </label>

          <div style={{ marginLeft: 10, display: "flex", gap: 8 }}>
            <span style={{ fontSize: 13 }}>{auth.currentUser?.displayName}</span>
            <button
              onClick={async () => {
                try {
                  await auth.signOut();
                } catch (err) {
                  console.error("Sign-out failed:", err);
                }
              }}
              style={smallBtn(false)}
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <section style={{ marginBottom: 12 }}>
        <YouTubeSearch onSaved={() => {}} />
        <DailymotionSearch onSaved={() => {}} />

        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Video link:</label>
          <input value={originalUrl} onChange={(e) => setOriginalUrl(e.target.value)} placeholder="Paste video link" style={{ width: "100%", padding: 8, marginBottom: 8 }} />

          <div style={{ display: "flex", gap: 8 }}>
            <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder="Custom title" style={{ flex: 1, padding: 8 }} />
            <button onClick={() => setCustomTitle("")} title="Clear" style={smallBtn(false)}>Clear</button>
          </div>

          <div style={{ marginTop: 8 }}>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description / notes" style={{ width: "100%", padding: 8, marginTop: 8, minHeight: 60 }} />
          </div>

          <div style={{ marginTop: 8 }}>
            <button onClick={save} style={{ background: "#1a73e8", color: "white", padding: "8px 14px", border: "none", borderRadius: 6 }}>
              Save Clip
            </button>
          </div>
        </div>
      </section>

      <section style={{ display: "flex", gap: 18 }}>
        <aside style={{ minWidth: 240 }}>
          <h4 style={{ marginTop: 0 }}>Playlists</h4>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <button
                onClick={() => setSelectedPlaylist("all")}
                style={{
                  display: "inline-block",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: selectedPlaylist === "all" ? "2px solid #b3d4ff" : "1px solid #ddd",
                  background: selectedPlaylist === "all" ? "#e6f0ff" : "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  width: "auto",
                }}
              >
                All
              </button>
            </div>

            {playlists.map((pl) => (
              <div key={pl.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={() => setSelectedPlaylist(pl.id)}
                  style={{
                    display: "inline-block",
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: selectedPlaylist === pl.id ? "2px solid #b3d4ff" : "1px solid #ddd",
                    background: selectedPlaylist === pl.id ? "#e6f0ff" : "#fff",
                    cursor: "pointer",
                    fontSize: 13,
                    width: "auto",
                  }}
                >
                  {pl.name}
                </button>
                <button
                  onClick={async () => {
                    if (!confirm("Delete this playlist? Clips will remain but that playlist will be removed")) return;
                    try {
                      await deleteDoc(doc(db, "users", auth.currentUser.uid, "playlists", pl.id));
                      const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
                      const q = query(clipsRef, where("playlistIds", "array-contains", pl.id));
                      const snap = await getDocs(q);
                      for (const d of snap.docs) {
                        await updateDoc(d.ref, { playlistIds: arrayRemove(pl.id) });
                      }
                      if (selectedPlaylist === pl.id) setSelectedPlaylist("all");
                    } catch (err) {
                      console.error(err);
                    }
                  }}
                  style={{ background: "transparent", color: "red", border: "none", cursor: "pointer" }}
                >
                  ✖
                </button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10 }}>
            <input placeholder="New playlist name" value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)} style={{ width: "100%", padding: 6 }} />
            <button onClick={createPlaylist} style={{ marginTop: 6 }}>Create</button>
          </div>

          {showTagCloud && (
            <div style={{ marginTop: 14 }}>
              <h4 style={{ marginBottom: 8 }}>Tag Cloud (visible clips)</h4>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.keys(tagCounts).length === 0 && <div style={{ color: "#666" }}>No tags yet</div>}
                {Object.entries(tagCounts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 200)
                  .map(([tag, cnt]) => (
                    <div key={tag} style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                      <button
                        onClick={() => setSelectedTagFilter(normalizeTag(tag))}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: selectedTagFilter === normalizeTag(tag) ? "2px solid #b3d4ff" : "1px solid #ddd",
                          background: selectedTagFilter === normalizeTag(tag) ? "#e6f0ff" : tagColor(tag),
                          color: selectedTagFilter === normalizeTag(tag) ? "#000" : "#fff",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                        title={`${cnt} clips`}
                      >
                        <span style={{ fontWeight: 600 }}>{tag}</span>
                        <span style={{ fontSize: 12, opacity: 0.9 }}>({cnt})</span>
                      </button>

                      {selectedTagFilter === normalizeTag(tag) ? (
                        <button onClick={() => setSelectedTagFilter(null)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "#555" }}>
                          Clear
                        </button>
                      ) : null}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </aside>

        <main style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>{selectedPlaylist === "all" ? "All Clips" : `Clips in: ${playlists.find((p) => p.id === selectedPlaylist)?.name || "Selected"}`}</h3>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {visibleClips.map((c) => {
              const tags = Array.isArray(c.tags) ? c.tags.map(normalizeTag) : [];
              const isOpen = !!popoverOpen[c.id];

              return (
                <div key={c.id} style={{ width: 360, border: "1px solid #ddd", padding: 8, borderRadius: 6, position: "relative" }}>
                  {/* three-dot menu button top-right */}
                  <button
                    onClick={(e) => togglePopover(c.id, e)}
                    title={isOpen ? "Hide options" : "Show options"}
                    data-popover-ignore
                    style={{
                      position: "absolute",
                      right: 8,
                      top: 8,
                      width: 32,
                      height: 28,
                      borderRadius: 6,
                      border: "1px solid #ccc",
                      background: "#fff",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      padding: 0,
                    }}
                    aria-expanded={isOpen}
                    aria-controls={`clip-popover-${c.id}`}
                  >
                    ⋯
                  </button>

                  {c.embedable && c.embedUrl ? (
                    c.videoSite === "file" ? (
                      <video width="340" height="200" controls src={c.embedUrl} />
                    ) : (
                      <iframe width="340" height="200" src={c.embedUrl} title={c.customTitle || "video"} frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                    )
                  ) : (
                    <a href={c.watchUrl || c.originalUrl} target="_blank" rel="noreferrer">Open video</a>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: "bold" }}>{c.customTitle || "No title"}</div>
                    <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{c.description}</div>

                    {/* POPPOVER: appears under the video area when open */}
                    {isOpen && (
                      <div
                        id={`clip-popover-${c.id}`}
                        data-popover-ignore
                        style={{
                          marginTop: 10,
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #e6e6e6",
                          background: "#fff",
                          boxShadow: "0 10px 30px rgba(16,24,40,0.06)",
                          zIndex: 50,
                        }}
                      >
                        {/* Playlists */}
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 13, marginBottom: 6 }}>Playlists:</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {playlists.length === 0 && <div style={{ color: "#666" }}>No playlists</div>}
                            {playlists.map((pl) => {
                              const checked = Array.isArray(c.playlistIds) && c.playlistIds.includes(pl.id);
                              return (
                                <label key={pl.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <input data-popover-ignore type="checkbox" checked={checked} onChange={(e) => toggleClipPlaylist(c.id, pl.id, e.target.checked)} />
                                  <span style={{ fontSize: 13 }}>{pl.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>

                        {/* Tags */}
                        {showTags && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                              <div style={{ fontSize: 13 }}>Tags</div>
                              <div style={{ fontSize: 12, color: "#666" }}>{tags.length} tag{tags.length !== 1 ? "s" : ""}</div>
                            </div>

                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                              {tags.length === 0 && <div style={{ color: "#666", fontSize: 12 }}>No tags</div>}
                              {tags.map((tag) => (
                                <div key={tag} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <button
                                    data-popover-ignore
                                    onClick={() => setSelectedTagFilter((prev) => (prev === tag ? null : tag))}
                                    onContextMenu={(e) => { e.preventDefault(); setEditingTagForClip({ clipId: c.id, tag }); }}
                                    style={{
                                      background: tagColor(tag),
                                      color: "#fff",
                                      padding: "4px 8px",
                                      borderRadius: 6,
                                      border: "none",
                                      cursor: "pointer",
                                      fontSize: 11,
                                    }}
                                    title="Click to filter by tag. Right-click to edit."
                                  >
                                    #{tag}
                                  </button>

                                  <button
                                    data-popover-ignore
                                    onClick={() => {
                                      if (!confirm(`Delete tag "${tag}" from this clip?`)) return;
                                      deleteTagFromClip(c.id, tag);
                                    }}
                                    title="Delete tag"
                                    style={{
                                      background: "transparent",
                                      border: "none",
                                      color: "#ef4444",
                                      cursor: "pointer",
                                      padding: 4,
                                      fontSize: 12,
                                    }}
                                  >
                                    ✖
                                  </button>
                                </div>
                              ))}
                            </div>

                            {/* Add-tag bar */}
                            {showAddTagBar && (
                              <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
                                <input
                                  placeholder="Add tag"
                                  value={newTagInputForClip[c.id] || ""}
                                  onChange={(e) => setNewTagInputForClip((s) => ({ ...s, [c.id]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      addTagToClip(c.id, newTagInputForClip[c.id] || "");
                                    }
                                  }}
                                  style={{ padding: "6px 8px", fontSize: 12, width: 120 }}
                                />
                                <button data-popover-ignore onClick={() => addTagToClip(c.id, newTagInputForClip[c.id] || "")} style={{ padding: "6px 8px", fontSize: 13 }}>
                                  +
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Actions */}
                        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                          <button data-popover-ignore onClick={() => editClip(c)} style={{ padding: "6px 10px", fontSize: 13 }}>Edit</button>
                          <button data-popover-ignore onClick={() => deleteClip(c.id)} style={{ background: "#e53935", color: "white", padding: "6px 10px", fontSize: 13 }}>
                            Delete
                          </button>
                          <button data-popover-ignore onClick={() => shareClip(c)} style={{ padding: "6px 10px", fontSize: 13 }}>Share</button>
                        </div>
                      </div>
                    )}
                    {/* end popover */}
                  </div>

                  {editingTagForClip && editingTagForClip.clipId === c.id && (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: "#fff", boxShadow: "0 6px 18px rgba(0,0,0,0.06)" }}>
                      <div style={{ marginBottom: 8 }}>
                        <strong>Edit tag</strong> (editing <code>#{editingTagForClip.tag}</code>)
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          defaultValue={editingTagForClip.tag}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              replaceTagOnClip(c.id, editingTagForClip.tag, e.target.value);
                            }
                          }}
                          style={{ flex: 1, padding: 6 }}
                        />
                        <button onClick={() => {
                          const input = document.activeElement;
                          const newVal = input && input.value ? input.value : editingTagForClip.tag;
                          replaceTagOnClip(c.id, editingTagForClip.tag, newVal);
                        }}>Save</button>
                        <button onClick={() => {
                          if (!confirm(`Delete tag "${editingTagForClip.tag}" from this clip?`)) return;
                          deleteTagFromClip(c.id, editingTagForClip.tag);
                          setEditingTagForClip(null);
                        }} style={{ background: "#ef4444", color: "#fff" }}>Delete</button>
                        <button onClick={() => setEditingTagForClip(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </main>
      </section>

      {/* Floating AI assistant toggle */}
      <button
        onClick={() => setChatVisible((v) => !v)}
        aria-label="Toggle ClipBook AI Assistant"
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 9999,
          width: 64,
          height: 64,
          borderRadius: 999,
          border: "none",
          boxShadow: "0 10px 30px rgba(16,24,40,0.18)",
          background: chatVisible ? "linear-gradient(135deg,#4c2fb5,#8e54ff)" : "linear-gradient(135deg,#6f42d6,#9a63ff)",
          color: "#fff",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden>
          <path d="M20 2H4a2 2 0 0 0-2 2v14l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" />
        </svg>
      </button>

      {chatVisible && (
        <div style={{ position: "fixed", right: 20, bottom: 100, zIndex: 9999, width: 360, maxWidth: "90vw" }}>
          <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", padding: 8, borderRadius: 8, boxShadow: "0 10px 30px rgba(16,24,40,0.08)" }}>
            <strong>ClipBook AI Assistant</strong>
            <button onClick={() => setChatVisible(false)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}>✖</button>
          </div>

          <ChatAI_HF playlistId={selectedPlaylist === "all" ? null : selectedPlaylist} hideTitle={true} />
        </div>
      )}
    </div>
  );
}
