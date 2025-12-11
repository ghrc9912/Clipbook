// functions/clipbot/index.js
// ClipBook ChatBot using GROQ (Free, Fast, Stable)

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

try { admin.initializeApp(); } catch (e) {}

const GROQ_KEY = process.env.GROQ_KEY;

// choose a good free Groq model:
const MODEL = "llama-3.1-8b-instant";   // fast + free + chat optimized

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// test route
app.get("/", (req, res) => {
  res.json({ ok: true, message: "ClipBook Groq ChatBot is active." });
});

// main chat route
app.post("/hf-chat", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt must be a string" });
    }

    if (!GROQ_KEY) {
      return res.status(500).json({ error: "GROQ_KEY is not set in environment variables" });
    }

    // request body for groq
    const body = {
      model: MODEL,
      messages: [
        { role: "system", content: "You are ClipBook assistant. Answer clearly." },
        { role: "user", content: prompt }
      ],
      max_tokens: 200
    };

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify(body)
    });

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error(data);
      return res.status(502).json({ error: "Groq API failed", details: data });
    }

    const answer = data?.choices?.[0]?.message?.content ?? "No response";

    return res.json({
      ok: true,
      provider: "groq",
      model: MODEL,
      result: answer
    });

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// export firebase gen2 endpoint
exports.api = onRequest(
  {
    region: "us-central1",
    memory: "256Mi",
    timeoutSeconds: 60,
    invoker: "public" // allow external access
  },
  app
);
