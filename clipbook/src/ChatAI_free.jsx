// src/ChatAI_free.jsx
import React, { useState } from "react";
import { db, auth } from "./firebase";
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  doc,
} from "firebase/firestore";

/*
  Zero-cost playlist-aware assistant (runs in browser, no paid LLM required).
  Accepts prop hideTitle to avoid rendering its own header when a parent already shows one.
*/

function shortText(text, max = 120) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function extractKeywordsFromTitle(title) {
  if (!title) return [];
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !"the,is,in,and,to,of,for,with,on,by,an,be".split(",").includes(w))
    .slice(0, 6);
}

export default function ChatAIFree({ playlistId = null, hideTitle = false }) {
  const [history, setHistory] = useState([]); // { from: 'user'|'bot', text }
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function fetchPlaylistContext(uid, pid) {
    if (!uid || !pid) return { playlist: null, clips: [] };
    try {
      const plSnap = await getDocs(query(collection(db, "users", uid, "playlists"), where("__name__", "==", pid), limit(1)));
      let playlist = null;
      if (!plSnap.empty) playlist = { id: plSnap.docs[0].id, ...(plSnap.docs[0].data() || {}) };

      const clipsQ = query(
        collection(db, "users", uid, "clips"),
        where("playlistIds", "array-contains", pid),
        orderBy("createdAt", "desc"),
        limit(200)
      );
      const clipsSnap = await getDocs(clipsQ);
      const clips = clipsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return { playlist, clips };
    } catch (err) {
      console.error("fetchPlaylistContext error", err);
      return { playlist: null, clips: [] };
    }
  }

  async function handleMessageRaw(text) {
    setLoading(true);
    try {
      const uid = auth.currentUser?.uid;
      const msg = (text || "").trim().toLowerCase();

      if (msg === "help" || msg === "what can you do") {
        return `I can:
- Summarize a playlist: "summarize playlist"
- Recommend next: "recommend next"
- Create a study plan: "study plan"
- Make a quiz: "quiz me"
Select a playlist in the UI first for playlist-specific answers.`;
      }

      if (msg.includes("playlist") || msg.includes("summarize") || msg.includes("what's in") || msg.includes("what is in")) {
        const pid = playlistId;
        if (!uid) return "Sign in to use playlist features.";
        if (!pid) return "No playlist selected. Select a playlist and try again.";
        const { playlist, clips } = await fetchPlaylistContext(uid, pid);
        if (!playlist) return "Playlist not found or empty.";
        if (!clips || clips.length === 0) return `Playlist "${playlist.name}" looks empty.`;
        const lines = clips.slice(0, 12).map((c, i) => `${i + 1}. ${c.customTitle || shortText(c.originalUrl, 40)} — ${shortText(c.description || "", 80)}`);
        return `Playlist "${playlist.name}" — ${clips.length} video(s):\n` + lines.join("\n");
      }

      if (msg.includes("recommend") || msg.includes("next") || msg.includes("what to watch")) {
        const pid = playlistId;
        if (!uid) return "Sign in to use playlist features.";
        if (!pid) return "No playlist selected. Select a playlist and try again.";
        const { clips } = await fetchPlaylistContext(uid, pid);
        if (!clips || clips.length === 0) return "Playlist empty.";
        let candidate = clips.find((c) => !c.watched) || clips[0];
        if (!(clips.every((c) => c.duration == null))) {
          const withDur = clips.filter((c) => typeof c.duration === "number");
          if (withDur.length) {
            withDur.sort((a, b) => a.duration - b.duration);
            const shortOne = withDur[0];
            if (!shortOne.watched) candidate = shortOne;
          }
        }
        return `Recommended next: ${candidate.customTitle || shortText(candidate.originalUrl, 60)}\nOpen: ${candidate.watchUrl || candidate.originalUrl || "No link available"}`;
      }

      if (msg.includes("study plan") || msg.includes("order") || msg.includes("learning path")) {
        const pid = playlistId;
        if (!uid) return "Sign in to use playlist features.";
        if (!pid) return "No playlist selected. Select a playlist and try again.";
        const { playlist, clips } = await fetchPlaylistContext(uid, pid);
        if (!clips || clips.length === 0) return "Playlist empty.";
        const ordered = [...clips].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const planLines = ordered.slice(0, 20).map((c, i) => `${i + 1}. ${c.customTitle || shortText(c.originalUrl, 60)}`);
        return `Study plan for "${playlist?.name || 'playlist'}":\n` + planLines.join("\n");
      }

      if (msg.includes("quiz") || msg.includes("question") || msg.includes("quiz me")) {
        const pid = playlistId;
        if (!uid) return "Sign in to use playlist features.";
        if (!pid) return "No playlist selected. Select a playlist and try again.";
        const { clips } = await fetchPlaylistContext(uid, pid);
        if (!clips || clips.length === 0) return "Playlist empty.";
        const qs = clips.slice(0, 6).map((c, i) => {
          const keywords = extractKeywordsFromTitle(c.customTitle || "");
          const kw = keywords[0] || (c.customTitle || "").split(" ")[0] || "topic";
          return `${i + 1}. What is the main idea of "${shortText(c.customTitle || '', 60)}"? (Hint: ${kw})`;
        });
        return `Quick quiz (short answers):\n` + qs.join("\n");
      }

      if (msg.length > 2) {
        const uid = auth.currentUser?.uid;
        if (!uid) return "Sign in to search your clips.";
        const clipsQ = query(collection(db, "users", uid, "clips"), orderBy("createdAt", "desc"), limit(200));
        const snap = await getDocs(clipsQ);
        const clips = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const matches = clips.filter((c) => {
          const t = (c.customTitle || "").toLowerCase() + " " + (c.description || "").toLowerCase();
          return t.includes(msg) || (c.tags || []).some((tg) => tg.toLowerCase().includes(msg));
        });
        if (matches.length === 0) return "No matching clips found in your library.";
        const list = matches.slice(0, 8).map((c, i) => `${i + 1}. ${c.customTitle || shortText(c.originalUrl, 60)} — ${shortText(c.description||"",80)}\nOpen: ${c.watchUrl || c.originalUrl || ""}`);
        return `Found ${matches.length} matching clip(s):\n` + list.join("\n\n");
      }

      return "I didn't understand that. Try: 'summarize playlist', 'recommend next', 'study plan', or 'quiz me'.";
    } finally {
      setLoading(false);
    }
  }

  const sendMessage = async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setHistory((h) => [...h, { from: "user", text }]);
    setInput("");
    const reply = await handleMessageRaw(text);
    setHistory((h) => [...h, { from: "bot", text: reply }]);
  };

  return (
    <div style={{ width: "100%", maxWidth: 760, border: "1px solid #ddd", padding: 12, borderRadius: 8, background: "#fff" }}>
      {/* only show title if parent hasn't already shown it */}
      {!hideTitle && <div style={{ fontWeight: 700, marginBottom: 8 }}>ClipBook AI Assistant</div>}

      <div style={{ height: 280, overflow: "auto", padding: 8, borderRadius: 6, background: "#fafafa", border: "1px solid #eee" }}>
        {history.length === 0 && <div style={{ color: "#666" }}>Try: "summarize playlist", "recommend next", "study plan", or "quiz me".</div>}
        {history.map((m, idx) => (
          <div key={idx} style={{ marginBottom: 10, textAlign: m.from === "user" ? "right" : "left" }}>
            <div style={{ display: "inline-block", padding: 8, borderRadius: 8, background: m.from === "user" ? "#e6f0ff" : "#f2f2f2", maxWidth: "90%" }}>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{m.text}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about your playlist or library..." style={{ flex: 1, padding: 8 }} />
        <button onClick={sendMessage} disabled={loading} style={{ padding: "8px 12px" }}>{loading ? "Working…" : "Ask"}</button>
      </div>
    </div>
  );
}
