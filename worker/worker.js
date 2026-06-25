// LinkedIn Defluffer — Cloudflare Worker.
// Public, no-auth proxy: the extension POSTs a post's text, the Worker calls
// Gemini 2.5 Flash-Lite with our defluff prompt and returns a one-line summary.
// The Google API key lives here as a secret (env.GEMINI_API_KEY) — never in the
// extension. Abuse is bounded by per-install-id + per-IP rate limits (below)
// plus your hard spend cap on the Google account.

const MODEL = "gemini-2.5-flash-lite";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_INPUT_CHARS = 2000; // bound per-call cost; LinkedIn posts rarely exceed this

const SYSTEM_PROMPT = `You defluff LinkedIn posts. People write long, self-important, AI-generated posts to say almost nothing. Your job: extract the single real point and state it in plain words.

Rules:
- Output ONE short line, max ~12 words.
- Write the summary in the SAME language as the post (Hebrew post → Hebrew summary, Spanish → Spanish, etc.). The examples below are English only to show the style — always match the post's language.
- Third person, factual, past or present tense.
- No emojis, no hashtags, no quotes, no hype words ("thrilled", "humbled", "excited", "journey", "game-changer").
- Use the author's name if it's clear from context; otherwise start with a neutral subject.
- If the post is genuinely just an announcement, say the announcement. Examples of the target style:
  "John graduated from Stanford."
  "Michael got promoted to VP of Sales."
  "Jonathan won a hackathon with a flood-prediction app."
  "Sarah is hiring two backend engineers."
  "Post shares 5 tips for cold email; nothing new."
- If there is truly no substance, say what it's gesturing at, e.g. "Generic motivational post about resilience."

Return only the line. Nothing else.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Install-Id",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return json({ error: "method" }, 405);

    // --- abuse limits: per install id, then per IP (soft, fixed 60s window) ---
    const installId = (request.headers.get("X-Install-Id") || "anon").slice(0, 64);
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    if (env.RL_INSTALL) {
      const { success } = await env.RL_INSTALL.limit({ key: installId });
      if (!success) return json({ error: "rate" }, 429);
    }
    if (env.RL_IP) {
      const { success } = await env.RL_IP.limit({ key: ip });
      if (!success) return json({ error: "rate" }, 429);
    }

    if (!env.GEMINI_API_KEY) return json({ error: "config" }, 500);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad-json" }, 400);
    }
    const text = String(body.text || "").slice(0, MAX_INPUT_CHARS).trim();
    const author = String(body.author || "").slice(0, 80).trim();
    if (!text) return json({ error: "empty" }, 400);

    const userContent = author ? `Author: ${author}\n\nPost:\n${text}` : `Post:\n${text}`;

    try {
      const resp = await fetch(`${ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.3,
            thinkingConfig: { thinkingBudget: 0 }, // no thinking — keep it fast and cheap
          },
        }),
      });

      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 200);
        return json({ error: `api-${resp.status}`, detail }, 502);
      }

      const data = await resp.json();
      const summary = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      if (!summary) return json({ error: "no-summary" }, 502);
      return json({ summary });
    } catch (e) {
      return json({ error: "upstream", detail: String(e) }, 502);
    }
  },
};
