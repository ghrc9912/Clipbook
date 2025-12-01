// src/Dashboard.jsx
import { useState, useEffect } from "react";
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
  arrayRemove
} from "firebase/firestore";
import YouTubeSearch from "./YouTubeSearch";
import DailymotionSearch from "./DailymotionSearch";

/**
 * getEmbedInfo(updated):
 * - Returns { site, embedUrl, embedable, watchUrl }
 */
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
          watchUrl: `https://www.youtube.com/watch?v=${id}`
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
          watchUrl: `https://vimeo.com/${id}`
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
          watchUrl: `https://${host}/video/${id}`
        };
    }

    // Metacafe
    if (host.includes("metacafe.com")) {
      const id = u.pathname.split("/").filter(Boolean)[1];
      if (id)
        return {
          site: "metacafe",
          embedUrl: `https://www.metacafe.com/embed/${id}/`,
          embedable: true,
          watchUrl: url
        };
    }

    // Direct video file
    if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i))
      return { site: "file", embedUrl: url, embedable: true, watchUrl: url };

    // Others
    return { site: host, embedUrl: url, embedable: false, watchUrl: url };
  } catch {
    return { site: "invalid", embedUrl: null, embedable: false, watchUrl: null };
  }
}

export default function Dashboard() {
  const [originalUrl, setOriginalUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [description, setDescription] = useState("");
  const [clips, setClips] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState("all");
  const [newPlaylistName, setNewPlaylistName] = useState("");

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

  // save new clip
  // ---------- REPLACE THE save() function IN Dashboard.jsx WITH THIS ----------
const generateAutoTags = (title, desc) => {
  const text = `${title || ""} ${desc || ""}`.toLowerCase();

  const map = {
    "react": "web-dev",
    "javascript": "web-dev",
    "node": "web-dev",
    "css": "web-dev",
    "html": "web-dev",
    "machine learning": "machine-learning",
    "machine-learning": "machine-learning",
    "ml": "machine-learning",
    "neural": "machine-learning",
    "deep learning": "machine-learning",
    "python": "python",
    "pandas": "data-science",
    "numpy": "data-science",
    "linear algebra": "math",
    "calculus": "math",
    "lecture": "lecture",
    "tutorial": "tutorial",
    "beginner": "beginner",
    "advanced": "advanced"
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
    // If the check fails, do not block saving — return false
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
      createdAt: Date.now()
    });
    setOriginalUrl("");
    setCustomTitle("");
    setDescription("");
  } catch (err) {
    console.error("Save failed:", err);
    alert("Could not save clip. See console.");
  }
};
// ---------- END REPLACEMENT ----------

  // Export all clips as CSV
  const exportClipsCSV = async () => {
    if (!auth.currentUser) return alert("Sign in first to export clips.");
    try {
      // fetch all clips for this user
      const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
      const snap = await getDocs(query(clipsRef, orderBy("createdAt", "desc")));
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (!docs.length) return alert("No clips to export.");

      // Build CSV rows
      const rows = [];
      // header
      rows.push([
        "id",
        "customTitle",
        "description",
        "watchUrl",
        "originalUrl",
        "videoSite",
        "tags",
        "playlistIds",
        "autoTagsGenerated",
        "createdAt"
      ]);

      // body
      for (const d of docs) {
        rows.push([
          d.id || "",
          (d.customTitle || "").replace(/\r?\n|\r/g, " "), // remove newlines
          (d.description || "").replace(/\r?\n|\r/g, " "),
          d.watchUrl || "",
          d.originalUrl || "",
          d.videoSite || "",
          Array.isArray(d.tags) ? d.tags.join("|") : "",
          Array.isArray(d.playlistIds) ? d.playlistIds.join("|") : "",
          d.autoTagsGenerated ? "true" : "false",
          d.createdAt ? new Date(d.createdAt).toISOString() : ""
        ]);
      }

      // convert rows to CSV string (escape quotes)
      const csv = rows
        .map(row =>
          row
            .map(cell => {
              if (cell === null || cell === undefined) return "";
              const s = String(cell).replace(/"/g, '""'); // escape double quotes
              // wrap in quotes if contains comma/newline/quote
              if (/[,"\n]/.test(s)) return `"${s}"`;
              return s;
            })
            .join(",")
        )
        .join("\n");

      // create blob and download
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

  // helpers
  const deleteClip = async (id) => {
    if (!auth.currentUser) return;
    const docRef = doc(db, "users", auth.currentUser.uid, "clips", id);
    try {
      await deleteDoc(docRef);
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
      setClips((prev) =>
        prev.map((c) =>
          c.id === clip.id ? { ...c, customTitle: newTitle || null, description: newDesc || null } : c
        )
      );
    } catch (err) {
      console.error("Edit failed:", err);
    }
  };

  // NEW: edit tags inline (prompt-based)
  const editTags = async (clip) => {
    const current = Array.isArray(clip.tags) ? clip.tags.join(", ") : "";
    const raw = prompt("Edit tags (comma-separated). Example: data-science, tutorial", current);
    if (raw === null) return; // cancelled
    const tags = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const docRef = doc(db, "users", auth.currentUser.uid, "clips", clip.id);
      await updateDoc(docRef, { tags, autoTagsGenerated: false });
      // update local state immediately
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
        createdAt: Date.now()
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

          <button
            onClick={exportClipsCSV}
            style={{ marginLeft: 10, padding: "8px 14px", borderRadius: 6 }}
          >
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
              <button
                onClick={() => setSelectedPlaylist(pl.id)}
                style={{ background: selectedPlaylist === pl.id ? "#ddd" : "transparent" }}
              >
                {pl.name}
              </button>
              <button
                onClick={() => deletePlaylist(pl.id)}
                style={{ border: "none", background: "transparent", color: "red" }}
              >
                ✖
              </button>
            </div>
          ))}

          <div style={{ marginTop: 12 }}>
            <input
              placeholder="New playlist name"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              style={{ width: "100%", padding: 6 }}
            />
            <button onClick={createPlaylist} style={{ marginTop: 6 }}>
              Create Playlist
            </button>
          </div>
        </aside>

        <main style={{ flex: 1 }}>
          <h3>
            {selectedPlaylist === "all"
              ? "All Clips"
              : `Clips in: ${playlists.find((p) => p.id === selectedPlaylist)?.name || "Selected"}`}
          </h3>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {clips.map((c) => (
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

                  {/* Tags - show auto-generated / user tags if present */}
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
                            cursor: "pointer"
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

                  {/* ✅ Multiple playlist checkboxes */}
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 13, marginBottom: 4 }}>Playlists:</div>
                    {playlists.map((pl) => {
                      const checked = Array.isArray(c.playlistIds) && c.playlistIds.includes(pl.id);
                      return (
                        <label key={pl.id} style={{ display: "inline-flex", alignItems: "center", marginRight: 8 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleClipPlaylist(c.id, pl.id, e.target.checked)}
                          />
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
                </div>
              </div>
            ))}
          </div>
        </main>
      </section>
    </div>
  );
}
