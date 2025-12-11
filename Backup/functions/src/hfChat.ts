// functions/src/hfChat.ts
/**
 * Hugging Face chat function for ClipBook
 * - Uses Router endpoint (router.huggingface.co/models/...)
 * - Reads HF key & model from functions config (set via firebase functions:config:set)
 * - Exports hfChat as an https.onCall function
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import fetch from "node-fetch";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Config (from functions config or environment)
const HF_KEY: string = (functions.config().huggingface?.key as string) || process.env.HF_KEY || "";
const HF_MODEL: string = (functions.config().huggingface?.model as string) || process.env.HF_MODEL || "google/gemma-2-2b-it";

// Simple in-memory rate limiter (for light testing only)
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQ = 15;
const buckets: Record<string, number[]> = {};
function withinLimit(uid: string) {
  const now = Date.now();
  const arr = buckets[uid] || [];
  const recent = arr.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQ) {
    buckets[uid] = recent;
    return false;
  }
  recent.push(now);
  buckets[uid] = recent;
  return true;
}

// Build a small playlist context string (top ~12 clips)
async function buildPlaylistContext(uid: string, playlistId?: string | null) {
  if (!uid || !playlistId) return "";
  try {
    const plDoc = await db.collection("users").doc(uid).collection("playlists").doc(playlistId).get();
    const pl = plDoc.exists ? plDoc.data() : null;

    const clipsSnap = await db
      .collection("users")
      .doc(uid)
      .collection("clips")
      .where("playlistIds", "array-contains", playlistId)
      .orderBy("createdAt", "desc")
      .limit(12)
      .get();

    const clips = clipsSnap.docs.map((d) => d.data());
    const lines = clips.map((c: any, i: number) => `${i + 1}. ${c.customTitle || c.originalUrl} — ${((c.description || "") + "").slice(0, 80)}`);
    if (!lines.length) return `Playlist: ${pl?.name || ""}\n(no clips)\n\n`;
    return `Playlist: ${pl?.name || ""}\n${lines.join("\n")}\n\n`;
  } catch (e) {
    console.error("buildPlaylistContext error:", e);
    return "";
  }
}

// The callable function
export const hfChat = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid || "anonymous";
  if (!withinLimit(uid)) return { error: "Rate limit exceeded. Try again later." };

  const message: string = (data?.message || "").toString();
  const playlistId: string | null = data?.playlistId || null;

  if (!message || message.trim().length === 0) return { error: "Empty message" };

  // Prepare context + prompt
  const playlistContext = await buildPlaylistContext(uid, playlistId);
  const systemNote = `You are ClipBook AI Assistant. Use the playlist context when provided. Be concise, helpful, and reference video titles when relevant.`;
  const prompt = `${systemNote}\n\n${playlistContext}User: ${message}\nAssistant:`;

  // Call Hugging Face Router endpoint (new endpoint)
  try {
    const routerUrl = `https://router.huggingface.co/models/${encodeURIComponent(HF_MODEL)}`;

    const response = await fetch(routerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 256,
          temperature: 0.2,
          // return_full_text is model-specific; router often returns generated_text fields
          return_full_text: false,
        },
        options: { wait_for_model: true },
      }),
    });

    if (!response.ok) {
      const txt = await response.text();
      console.error("Hugging Face Router error:", response.status, txt);
      return { error: `Model request failed (${response.status})` };
    }

    const json: any = await response.json();

    // Extract text from common HF response shapes
    let reply = "";
    if (Array.isArray(json) && json[0]?.generated_text) {
      reply = json[0].generated_text;
    } else if (json?.generated_text) {
      reply = json.generated_text;
    } else if (json?.data && Array.isArray(json.data) && json.data[0]?.generated_text) {
      reply = json.data[0].generated_text;
    } else if (typeof json === "string") {
      reply = json;
    } else {
      // Fallback: try to stringify a reasonable part
      try {
        reply = JSON.stringify(json).slice(0, 4000);
      } catch {
        reply = "No reply from model (unexpected response shape).";
      }
    }

    // Save conversation (non-blocking best-effort)
    (async () => {
      try {
        await db.collection("users").doc(uid).collection("conversations").add({
          userMessage: message,
          botReply: reply,
          playlistId: playlistId || null,
          createdAt: Date.now(),
        });
      } catch (e) {
        console.error("save conversation error:", e);
      }
    })();

    return { reply };
  } catch (err) {
    console.error("hfChat exception:", err);
    return { error: "Server error calling Hugging Face. See logs." };
  }
});
