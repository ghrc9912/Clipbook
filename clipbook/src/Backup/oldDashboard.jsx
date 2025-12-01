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
  getDocs
} from "firebase/firestore";
import YouTubeSearch from "./YouTubeSearch";
import DailymotionSearch from "./DailymotionSearch";


/**
 * getEmbedInfo(updated):
 * - Returns { site, embedUrl, embedable, watchUrl }
 * - embedable = true only for providers we know embed reliably (youtube, vimeo, dailymotion, metacafe, file)
 * - watchUrl: canonical page URL the user should open/share (used by "Share")
 */
function getEmbedInfo(rawUrl) {
  if (!rawUrl) return { site: "unknown", embedUrl: null, embedable: false, watchUrl: null };

  const url = rawUrl.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // YouTube
    if (host.includes("youtube.com") || host === "youtu.be") {
      const id = (u.searchParams.get("v")) || (u.pathname.split("/")[1]);
      if (id) {
        return {
          site: "youtube",
          embedUrl: `https://www.youtube.com/embed/${id}`,
          embedable: true,
          watchUrl: `https://www.youtube.com/watch?v=${id}`
        };
      }
    }

    // Vimeo
    if (host.includes("vimeo.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      const id = parts[parts.length - 1];
      if (id && /^[0-9]+$/.test(id)) {
        return {
          site: "vimeo",
          embedUrl: `https://player.vimeo.com/video/${id}`,
          embedable: true,
          watchUrl: `https://vimeo.com/${id}`
        };
      }
    }

    // Dailymotion
    if (host.includes("dailymotion.com") || host.includes("dai.ly")) {
      const parts = u.pathname.split("/").filter(Boolean);
      const id = parts[parts.length - 1];
      if (id) {
        return {
          site: "dailymotion",
          embedUrl: `https://www.dailymotion.com/embed/video/${id}`,
          embedable: true,
          watchUrl: host.includes("dailymotion.com") ? `https://${host}/video/${id}` : `https://dai.ly/${id}`
        };
      }
    }

    // Metacafe
    if (host.includes("metacafe.com")) {
      // metacafe.com/watch/<id>/...
      const parts = u.pathname.split("/").filter(Boolean);
      const maybeId = parts[1] || parts[0];
      if (maybeId) {
        return {
          site: "metacafe",
          embedUrl: `https://www.metacafe.com/embed/${maybeId}/`,
          embedable: true,
          watchUrl: `https://${host}${u.pathname}`
        };
      }
    }

    // Direct video file links -> video tag
    if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i)) {
      return { site: "file", embedUrl: url, embedable: true, watchUrl: url };
    }

    // Rumble & PeerTube & Veoh & others: mark as NOT embedable by default and set watchUrl to original URL
    if (host.includes("rumble.com") || host.includes("peertube") || host.includes("veoh") || host.includes("peer")) {
      return { site: host, embedUrl: url, embedable: false, watchUrl: url };
    }

    // fallback: unknown host -> not embedable but return original link as watchUrl
    return { site: host, embedUrl: url, embedable: false, watchUrl: url };
  } catch (err) {
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

  useEffect(() => {
    if (!auth.currentUser) return;
    const plRef = collection(db, "users", auth.currentUser.uid, "playlists");
    const unsubPl = onSnapshot(plRef, snap => {
      setPlaylists(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return () => unsubPl();
  }, []);

  useEffect(() => {
    if (!auth.currentUser) return;
    const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
    if (selectedPlaylist !== "all") {
      const q = query(clipsRef, where("playlistId", "==", selectedPlaylist), orderBy("createdAt", "desc"));
      return onSnapshot(q, snap => setClips(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    } else {
      const q = query(clipsRef, orderBy("createdAt", "desc"));
      return onSnapshot(q, snap => setClips(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    }
  }, [selectedPlaylist]);

  // Save clip with embed info and canonical watchUrl
  const save = async () => {
    if (!originalUrl) return alert("Paste a video link first");
    const info = getEmbedInfo(originalUrl);
    if (info.site === "invalid") return alert("Invalid URL");
    try {
      await addDoc(collection(db, "users", auth.currentUser.uid, "clips"), {
        originalUrl,
        videoSite: info.site,
        embedUrl: info.embedUrl || null,
        embedable: !!info.embedable,
        watchUrl: info.watchUrl || originalUrl,
        customTitle: customTitle || null,
        description: description || null,
        playlistId: null,
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

    // ✅ Optimistic update: update state immediately
    setClips((prev) =>
      prev.map((c) =>
        c.id === clip.id ? { ...c, customTitle: newTitle || null, description: newDesc || null } : c
      )
    );
  } catch (err) {
    console.error("Edit failed:", err);
    alert("Could not edit clip. Check console.");
  }
};
  const moveClipTo = async (clipId, playlistId) => {
    try {
      const docRef = doc(db, "users", auth.currentUser.uid, "clips", clipId);
      await updateDoc(docRef, { playlistId: playlistId || null });
    } catch (err) {
      console.error("Move failed:", err);
      alert("Could not move clip. Check console.");
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
      alert("Could not create playlist. Check console.");
    }
  };

  // NEW: delete playlist and unassign clips (set playlistId -> null)
  const deletePlaylist = async (plId) => {
    if (!confirm("Delete this playlist? Clips will remain but be moved to 'None'.")) return;
    try {
      // remove playlist doc
      await deleteDoc(doc(db, "users", auth.currentUser.uid, "playlists", plId));
      // find clips assigned to this playlist and unset them
      const clipsRef = collection(db, "users", auth.currentUser.uid, "clips");
      const q = query(clipsRef, where("playlistId", "==", plId));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        const docRef = doc(db, "users", auth.currentUser.uid, "clips", d.id);
        await updateDoc(docRef, { playlistId: null });
      }
      // if we deleted selected playlist, reset filter
      if (selectedPlaylist === plId) setSelectedPlaylist("all");
    } catch (err) {
      console.error("Delete playlist failed:", err);
      alert("Could not delete playlist. Check console.");
    }
  };

  // Share uses canonical watchUrl if present
  const shareClip = async (c) => {
    const watch = c.watchUrl || c.originalUrl || (c.embedUrl || "");
    const payload = `${watch}\n\nTitle: ${c.customTitle || ""}\n\n${c.description || ""}\n\nShared from ClipBook`;
    try {
      await navigator.clipboard.writeText(payload);
      alert("Copied share text to clipboard!");
    } catch (err) {
      console.error("Share failed:", err);
      alert("Could not copy. Here's the link: " + watch);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ClipBook</h1>
        <div>
          <span style={{ marginRight: 8 }}>{auth.currentUser?.displayName}</span>
          <button onClick={() => auth.signOut()}>Logout</button>
        </div>
      </header>

      <section style={{ marginBottom: 16 }}>
        {/* YouTube search component */}
        <YouTubeSearch onSaved={() => { /* optional: placeholder callback */ }} />
        <DailymotionSearch onSaved={() => {}} />

        <div style={{ marginBottom: 8 }}>
          <label htmlFor="urlInput">Video link (any supported site):</label>
          <input
            id="urlInput"
            value={originalUrl}
            onChange={(e) => setOriginalUrl(e.target.value)}
            placeholder="Paste YouTube / Vimeo / Dailymotion / Rumble / PeerTube ... link"
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <label htmlFor="titleInput">Custom title:</label>
          <input
            id="titleInput"
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            placeholder="Give this clip a custom title"
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <label htmlFor="descInput">Description / About video (optional):</label>
          <textarea
            id="descInput"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional: add notes, summary, why this clip is useful"
            style={{ width: "100%", padding: 8, marginTop: 4, minHeight: 80 }}
          />
        </div>

        <button
          onClick={save}
          style={{ backgroundColor: "#1a73e8", color: "white", padding: "8px 14px", borderRadius: 6, border: "none" }}
        >
          Save Clip
        </button>
      </section>

      <section style={{ display: "flex", gap: 20 }}>
        <aside style={{ minWidth: 220 }}>
          <h3>Playlists</h3>
          <div>
            <button onClick={() => setSelectedPlaylist("all")} style={{ marginBottom: 6, display: "block" }}>
              All
            </button>
          </div>

          {playlists.map(pl => (
            <div key={pl.id} style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => setSelectedPlaylist(pl.id)}
                style={{ background: selectedPlaylist === pl.id ? "#ddd" : "transparent" }}
              >
                {pl.name}
              </button>
              <button
                aria-label={`Delete playlist ${pl.name}`}
                onClick={() => deletePlaylist(pl.id)}
                title="Delete playlist (clips will remain)"
                style={{ background: "transparent", border: "none", color: "#e53935", cursor: "pointer" }}
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
            <button onClick={createPlaylist} style={{ marginTop: 6 }}>Create Playlist</button>
          </div>
        </aside>

        <main style={{ flex: 1 }}>
          <h3>
            {selectedPlaylist === "all"
              ? "All Clips"
              : `Clips in: ${playlists.find(p => p.id === selectedPlaylist)?.name || "Selected"}`}
          </h3>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {clips.map(c => (
              <div key={c.id} style={{ width: 360, border: "1px solid #ddd", padding: 8, borderRadius: 6 }}>
                {c.embedable && c.embedUrl ? (
                  c.videoSite === "file" ? (
                    <video width="340" height="200" controls src={c.embedUrl} style={{ display: "block" }} />
                  ) : (
                    <iframe
                      width="340"
                      height="200"
                      src={c.embedUrl}
                      title={c.customTitle || c.description || `Video ${c.id}`}
                      frameBorder="0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      style={{ display: "block" }}
                    />
                  )
                ) : (
                  <div style={{ padding: 16, minHeight: 200, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                    <div style={{ marginBottom: 8, textAlign: "center" }}>
                      <strong>{c.customTitle || c.description || "Saved link"}</strong>
                    </div>
                    <a href={c.watchUrl || c.originalUrl || c.embedUrl} target="_blank" rel="noreferrer">Open on original site</a>
                  </div>
                )}

                <div style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: "bold" }}>{c.customTitle || "No title"}</div>
                  <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{c.description}</div>

                  <div style={{ marginTop: 8 }}>
                    <label htmlFor={`move-${c.id}`}>Move to:</label>
                    <select
                      id={`move-${c.id}`}
                      value={c.playlistId || "none"}
                      onChange={(e) => {
                        const val = e.target.value === "none" ? null : e.target.value;
                        moveClipTo(c.id, val);
                      }}
                      style={{ marginLeft: 8 }}
                    >
                      <option value="none">None</option>
                      {playlists.map(pl => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
                    </select>
                  </div>

                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button onClick={() => editClip(c)}>Edit</button>
                    <button onClick={() => {
                      if (confirm("Delete this clip?")) deleteClip(c.id);
                    }} style={{ backgroundColor: "#e53935", color: "white" }}>Delete</button>
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
