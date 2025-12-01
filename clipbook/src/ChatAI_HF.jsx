// src/ChatAI_HF.jsx
// HuggingFace chat for ClipBook — uses your Firebase Cloud Function proxy.
// Human-like single-line comments used throughout.

import React, { useEffect, useState } from "react";
import { auth, db } from "./firebase"; // your firebase.js (already in project)
import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";

export default function ChatAI_HF({ initialConversationId = null, playlistId = null, hideTitle = false }) {
  // small state
  const [convId, setConvId] = useState(initialConversationId);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  // IMPORTANT: your deployed function base URL (replace if you later redeploy)
  const HF_PROXY_BASE = "https://api-4wepxhinxa-uc.a.run.app";
  const HF_PROXY_ENDPOINT = `${HF_PROXY_BASE}/hf-chat`; // POST { prompt: "..." }

  // create conversation doc + subscribe to messages when user & convId available
  useEffect(() => {
    const user = auth.currentUser;
    if (!user) return;

    // create a conversation doc if we don't have one yet
    const ensureConv = async () => {
      if (!convId) {
        const convRef = await addDoc(collection(db, "users", user.uid, "aiChats"), {
          createdAt: serverTimestamp(),
          playlistId: playlistId || null,
        });
        setConvId(convRef.id);
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

  // helper: call your proxy and return assistant text (best-effort)
  async function callProxy(prompt) {
    const resp = await fetch(HF_PROXY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Proxy error: ${resp.status} ${txt}`);
    }
    const j = await resp.json();
    // j.result may be string or array/object depending on model; try common fields
    if (Array.isArray(j.result) && j.result[0]?.generated_text) return j.result[0].generated_text;
    if (j.result?.generated_text) return j.result.generated_text;
    if (typeof j.result === "string") return j.result;
    // fallback stringify
    return JSON.stringify(j.result);
  }

  // send message handler
  const sendMessage = async (e) => {
    if (e) e.preventDefault();
    const user = auth.currentUser || { uid: "guest" };
    const text = input.trim();
    if (!text || !convId) return;
    setInput("");
    setLoading(true);

    // optimistic local write: store user message in Firestore
    try {
      await addDoc(collection(db, "users", user.uid, "aiChats", convId, "messages"), {
        from: "user",
        text,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn("Failed to add user message to Firestore", err);
    }

    // Call proxy and store assistant reply
    try {
      const prompt = `PlaylistId: ${playlistId || "none"}\nUser: ${text}\nAssistant:`;
      const replyText = await callProxy(prompt);

      await addDoc(collection(db, "users", user.uid, "aiChats", convId, "messages"), {
        from: "assistant",
        text: replyText,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("Chat error:", err);
      // show helpful assistant message if proxy failed
      await addDoc(collection(db, "users", user.uid, "aiChats", convId, "messages"), {
        from: "assistant",
        text: `Error: ${err.message || "Could not reach HF proxy."}`,
        createdAt: serverTimestamp(),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ width: 360, background: "#fff", padding: 12, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }}>
      {!hideTitle && <div style={{ fontWeight: 700, marginBottom: 8 }}>ClipBook AI (HuggingFace)</div>}

      <div style={{ height: 260, overflowY: "auto", marginBottom: 10 }}>
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
          placeholder="Ask about clips, titles, tags..."
          style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
        />
        <button type="submit" disabled={loading} style={{ padding: "8px 12px", borderRadius: 8 }}>
          {loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
