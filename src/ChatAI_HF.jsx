// src/ChatAI_HF.jsx
// Profile-aware ClipBook AI chat — fetches the logged-in user's clips/playlists
// and injects a concise profile context into every prompt so replies are specific
// to the currently logged-in profile. Based on original ChatAI_HF (kept style).
//
// Original: ChatAI_HF.jsx (modified). :contentReference[oaicite:4]{index=4}

import React, { useEffect, useState, useRef } from "react";
import { auth, db } from "./firebase";
import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  getDocs,
  limit as firestoreLimit,
} from "firebase/firestore";

// small utilities
const truncate = (s, n = 160) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const fmtDate = (ts) => {
  if (!ts) return "unknown";
  try {
    const d = new Date(typeof ts === "number" ? ts : ts.toMillis ? ts.toMillis() : ts);
    return d.toLocaleString();
  } catch {
    return "unknown";
  }
};

// IMPORTANT: your deployed function base URL (replace if you later redeploy)
const HF_PROXY_BASE = "https://api-4wepxhinxa-uc.a.run.app";
const HF_PROXY_ENDPOINT = `${HF_PROXY_BASE}/hf-chat`; // POST { prompt: "..." }

// Build a short, focused profile context string from clips + playlists + user.
function buildProfileContext({ user, clips, playlists }) {
  if (!user) return "No user logged in.";

  const totalClips = clips.length;
  const totalPlaylists = playlists.length;

  const siteCounts = {};
  const tagCounts = {};
  for (const c of clips) {
    const site = c.videoSite || "unknown";
    siteCounts[site] = (siteCounts[site] || 0) + 1;
    const tags = Array.isArray(c.tags) ? c.tags : [];
    for (const t of tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t, count]) => `${t}(${count})`);

  const playlistNames = playlists.map((p) => p.name).slice(0, 20);

  const sampleClips = clips
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 12)
    .map((c) => ({
      id: c.id,
      title: truncate(c.customTitle || c.originalUrl || "No title", 140),
      watchUrl: c.watchUrl || c.originalUrl || "",
      createdAt: fmtDate(c.createdAt),
      playlists: Array.isArray(c.playlistIds) ? c.playlistIds.join(",") : "",
      tags: Array.isArray(c.tags) ? c.tags.join(",") : "",
      desc: truncate(c.description || "", 240),
    }));

  let out = "";
  out += `User: ${user.displayName || user.email || user.uid}\n`;
  out += `TotalClips: ${totalClips}; Playlists: ${totalPlaylists};\n`;
  out += `BySite: ${Object.entries(siteCounts)
    .map(([s, n]) => `${s}:${n}`)
    .join(", ") || "none"}\n`;
  out += `TopTags: ${topTags.join(", ") || "none"}\n`;
  out += `Playlists: ${playlistNames.join(" | ") || "none"}\n`;
  out += `SampleClips:\n`;
  for (const sc of sampleClips) {
    out += `- [${sc.id}] Title: ${sc.title}; Date: ${sc.createdAt}; Playlists: ${sc.playlists}; Tags: ${sc.tags}; URL: ${sc.watchUrl}\n`;
    if (sc.desc) out += `  Desc: ${sc.desc}\n`;
  }

  if (out.length > 18_000) {
    return out.slice(0, 17_900) + "\n…(truncated)";
  }
  return out;
}

export default function ChatAI_HF({ initialConversationId = null, playlistId = null, hideTitle = false }) {
  const [convId, setConvId] = useState(initialConversationId);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const [clips, setClips] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [profileContext, setProfileContext] = useState("Profile not loaded yet.");
  const userRef = useRef(null);

  const clipsRefRef = useRef(null);
  const playlistsRefRef = useRef(null);

  // Create conversation doc if needed
  useEffect(() => {
    const user = auth.currentUser;
    if (!user) return;
    userRef.current = user;

    const ensureConv = async () => {
      if (!convId) {
        try {
          const convRef = await addDoc(collection(db, "users", user.uid, "aiChats"), {
            createdAt: serverTimestamp(),
            playlistId: playlistId || null,
          });
          setConvId(convRef.id);
        } catch (err) {
          console.warn("Could not create conv doc:", err);
        }
      }
    };

    ensureConv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.currentUser]);

  // subscribe to messages subcollection once convId exists
  useEffect(() => {
    if (!convId || !auth.currentUser) return;
    const msgsRef = collection(db, "users", auth.currentUser.uid, "aiChats", convId, "messages");
    const q = query(msgsRef, orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setMessages(arr);
    });
    return () => unsub();
  }, [convId]);

  // subscribe to clips + playlists
  useEffect(() => {
    const user = auth.currentUser;
    if (!user) return;

    const clipsCollection = collection(db, "users", user.uid, "clips");
    clipsRefRef.current = clipsCollection;
    const clipsQuery = query(clipsCollection, orderBy("createdAt", "desc"));
    const unsubClips = onSnapshot(clipsQuery, (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setClips(arr);
    });

    const playlistsCollection = collection(db, "users", user.uid, "playlists");
    playlistsRefRef.current = playlistsCollection;
    const playlistsQuery = query(playlistsCollection, orderBy("createdAt", "desc"));
    const unsubPlaylists = onSnapshot(playlistsQuery, (snap) => {
      setPlaylists(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    return () => {
      unsubClips();
      unsubPlaylists();
    };
  }, [auth.currentUser]);

  // rebuild profile context when data changes
  useEffect(() => {
    const user = auth.currentUser;
    const ctx = buildProfileContext({ user: user || userRef.current, clips: clips || [], playlists: playlists || [] });
    setProfileContext(ctx);
  }, [clips, playlists, auth.currentUser]);

  // helper: call proxy with profileContext prefixed
  async function callProxy(prompt) {
    const fullPrompt = `Context:\n${truncate(profileContext, 16000)}\n\nUserQuestion:\n${prompt}\n\nAssistant:`;

    const resp = await fetch(HF_PROXY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: fullPrompt }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Proxy error: ${resp.status} ${txt}`);
    }
    const j = await resp.json();
    if (Array.isArray(j.result) && j.result[0]?.generated_text) return j.result[0].generated_text;
    if (j.result?.generated_text) return j.result.generated_text;
    if (typeof j.result === "string") return j.result;
    return JSON.stringify(j.result);
  }

  const sendMessage = async (e) => {
    if (e) e.preventDefault();
    const user = auth.currentUser || { uid: "guest" };
    const text = input.trim();
    if (!text || !convId) return;
    setInput("");
    setLoading(true);

    try {
      await addDoc(collection(db, "users", user.uid, "aiChats", convId, "messages"), {
        from: "user",
        text,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn("Failed to add user message to Firestore", err);
    }

    try {
      const replyText = await callProxy(text);

      await addDoc(collection(db, "users", user.uid, "aiChats", convId, "messages"), {
        from: "assistant",
        text: replyText,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("Chat error:", err);
      await addDoc(collection(db, "users", user.uid, "aiChats", convId, "messages"), {
        from: "assistant",
        text: `Error: ${err.message || "Could not reach HF proxy."}`,
        createdAt: serverTimestamp(),
      });
    } finally {
      setLoading(false);
    }
  };

  const forceRefreshProfile = async () => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      const clipsSnap = await getDocs(query(collection(db, "users", user.uid, "clips"), orderBy("createdAt", "desc"), firestoreLimit(300)));
      const playlistsSnap = await getDocs(query(collection(db, "users", user.uid, "playlists"), orderBy("createdAt", "desc")));
      const clipsArr = clipsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const playlistsArr = playlistsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setClips(clipsArr);
      setPlaylists(playlistsArr);
    } catch (err) {
      console.warn("Force refresh failed", err);
    }
  };

  return (
    <div style={{ width: 360, background: "#fff", padding: 12, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }}>
      {!hideTitle && <div style={{ fontWeight: 700, marginBottom: 8 }}>ClipBook AI (Profile-aware)</div>}

      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
        <div style={{ marginBottom: 6 }}>
          <strong>Profile snapshot (used by AI):</strong>
        </div>
        <div style={{ maxHeight: 140, overflowY: "auto", padding: 6, background: "#fafafa", borderRadius: 6, border: "1px solid #eee", whiteSpace: "pre-wrap", fontSize: 12 }}>
          {profileContext}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={forceRefreshProfile} style={{ padding: "6px 8px", borderRadius: 6 }}>Refresh profile</button>
        </div>
      </div>

      <div style={{ height: 200, overflowY: "auto", marginBottom: 10 }}>
        {messages.length === 0 && <div style={{ color: "#666", fontSize: 13 }}>No messages yet — ask it.</div>}
        {messages.map((m) => (
          <div key={m.id || Math.random()} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#666" }}>{m.from === "user" ? "You" : "Assistant"}</div>
            <div style={{ marginTop: 4, padding: 8, borderRadius: 8, background: m.from === "user" ? "#eef" : "#f3f3f3", whiteSpace: "pre-wrap" }}>
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={sendMessage} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about clips, titles, tags... (profile-aware)"
          style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
        />
        <button type="submit" disabled={loading} style={{ padding: "8px 12px", borderRadius: 8 }}>
          {loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
