// src/Dashboard.jsx
// Dashboard with manual Save using AI tags when enabled.
// Based on original Dashboard; added `Use AI tags` toggle and local generateAITags.
// Keep rest of your Dashboard behavior the same. :contentReference[oaicite:7]{index=7}

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
  arrayRemove,
} from "firebase/firestore";
import YouTubeSearch from "./YouTubeSearch";
import DailymotionSearch from "./DailymotionSearch";
import ChatAIFree from "./ChatAI_free";
import ChatAI_HF from "./ChatAI_HF";

// tiny inline placeholder thumbnail
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%' height='100%' fill='#eee'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#777' font-size='16'>No thumbnail</text></svg>`
  );

// small helper to truncate
const truncate = (s, n = 1500) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

// rule-based fallback tag mapping (kept)
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

// AI tagger (same logic used in Search components)
async function generateAITags(title, desc) {
  const HF_PROXY_ENDPOINT = "https://api-4wepxhinxa-uc.a.run.app/hf-chat";
  const shortTitle = truncate(title, 800);
  const shortDesc = truncate(desc, 1800);

  const prompt = `You are a concise tag generator. Given the video title and description, return a JSON object with a single field "tags" containing up to 8 short, single-word or short-phrase tags suitable as categories. Do not include explanation.

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
    if (Array.isArray(parsed.tags)) return parsed.tags.map((t) => String(t).trim()).filter(Boolean);
    if (typeof parsed.tags === "string") return parsed.tags.split(",").map((t) => t.trim()).filter(Boolean);
  } catch (e) {
    const commaSplit = txt.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    const candidate = commaSplit.filter((x) => x.length <= 30).slice(0, 8);
    if (candidate.length) return candidate;
    throw new Error("AI response could not be parsed.");
  }
  throw new Error("AI response did not contain tags.");
}

export default function Dashboard() {
  const [originalUrl, setOriginalUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [description, setDescription] = useState("");
  const [clips, setClips] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState("all");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [chatVisible, setChatVisible] = useState(false);
  const [useAITagsForManualSave, setUseAITagsForManualSave] = useState(true);

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

  const save = async () => {
    console.log("Dashboard.save called");
    if (!originalUrl) return alert("Paste a video link first");
    // attempt to parse embed info (same helper as before)
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

    // try to generate AI tags if enabled (manual paste)
    let thumbnailUrl = null;
    try {
      if (info.site === "youtube") {
        const id = info.watchUrl?.split("v=")[1] || null;
        if (id) thumbnailUrl = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      }
    } catch (e) {
      thumbnailUrl = null;
    }

    // determine title/description to feed tags
    const titleForTags = customTitle || "";
    const descForTags = description || "";

    let tagsToSave = [];
    if (useAITagsForManualSave) {
      try {
        tagsToSave = await generateAITags(titleForTags || info.watchUrl || originalUrl, descForTags || "");
      } catch (err) {
        console.warn("AI tags failed for manual save:", err);
        tagsToSave = generateAutoTags(titleForTags, descForTags);
      }
    } else {
      tagsToSave = generateAutoTags(titleForTags, descForTags);
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
        thumbnailUrl: thumbnailUrl || null,
        tags: tagsToSave,
        autoTagsGenerated: !!useAITagsForManualSave,
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
        <YouTubeSearch onSaved={() => { /* no-op; Chat listens to Firestore */ }} />
        <DailymotionSearch onSaved={() => { /* no-op; Chat listens to Firestore */ }} />

        <label>Video link:</label>
        <input value={originalUrl} onChange={(e) => setOriginalUrl(e.target.value)} placeholder="Paste video link" style={{ width: "100%", padding: 8, marginBottom: 8 }} />

        <label>Custom title:</label>
        <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />

        <label>Description / notes:</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8, minHeight: 60 }} />

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={useAITagsForManualSave} onChange={(e) => setUseAITagsForManualSave(e.target.checked)} /> Use AI tags for this save
          </label>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} style={{ background: "#1a73e8", color: "white", padding: "8px 14px", border: "none", borderRadius: 6 }}>
            Save Clip
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
          <h3>{selectedPlaylist === "all" ? "All Clips" : `Clips in: ${playlists.find((p) => p.id === selectedPlaylist)?.name || "Selected"}`}</h3>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {clips.map((c) => {
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
                  </div>
                </div>
              );
            })}
          </div>
        </main>
      </section>

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
        <div style={{
          position: "fixed",
          right: 20,
          bottom: 100,
          zIndex: 9999,
          width: 360,
          maxWidth: "90vw",
        }}>
          <div style={{
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#fff",
            padding: 8,
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(16,24,40,0.08)"
          }}>
            <strong>ClipBook AI Assistant</strong>
            <button onClick={() => { setChatVisible(false); }} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}>✖</button>
          </div>

          <ChatAI_HF 
            playlistId={selectedPlaylist === "all" ? null : selectedPlaylist}
            hideTitle={true}
          />
        </div>
      )}
    </div>
  );
}
