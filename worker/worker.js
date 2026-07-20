// LinkedIn Defluffer — Cloudflare Worker.
// Public, no-auth proxy: the extension POSTs a post's text, the Worker calls
// Gemini 2.5 Flash-Lite with our defluff prompt and returns a one-line summary.
// The Google API key lives here as a secret (env.GEMINI_API_KEY) — never in the
// extension. Abuse is bounded by per-install-id + per-IP rate limits (below)
// plus your hard spend cap on the Google account.

import {
  MODEL,
  MAX_INPUT_CHARS,
  SYSTEM_PROMPT,
  GENERATION_CONFIG,
  FLUFF_GRADES,
  buildUserContent,
} from "./prompt.mjs";

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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
    const lang = String(body.lang || "").slice(0, 20).trim();
    if (!text) return json({ error: "empty" }, 400);

    // A detected language is a hard order — it overrides the author name (often
    // Latin) and the general "match the language" rule. Set only for scripts the
    // model otherwise drifts away from (today: Hebrew). See prompt.js.
    const userContent = buildUserContent(text, author, lang);

    try {
      const resp = await fetch(`${ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: GENERATION_CONFIG,
        }),
      });

      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 200);
        return json({ error: `api-${resp.status}`, detail }, 502);
      }

      const data = await resp.json();
      const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      if (!raw) return json({ error: "no-summary" }, 502);
      // Structured output: {fluff, summary}. Fall back to treating the whole
      // text as the summary if the model ever returns bare text.
      let summary = raw;
      let fluff = "";
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.summary === "string") {
          summary = parsed.summary.trim();
          if (FLUFF_GRADES.includes(parsed.fluff)) fluff = parsed.fluff;
        }
      } catch {
        // Malformed JSON — usually truncation at maxOutputTokens. Salvage the
        // summary text rather than leaking raw JSON into the user's feed; if
        // nothing salvageable, error out so the extension quietly skips.
        const fm = raw.match(/"fluff"\s*:\s*"(LOW|MEDIUM|HIGH|PURE)"/);
        if (fm) fluff = fm[1];
        const sm = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (sm) summary = sm[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
        else if (raw.trimStart().startsWith("{")) return json({ error: "bad-model-json" }, 502);
      }
      if (!summary) return json({ error: "no-summary" }, 502);
      return json({ summary, fluff });
    } catch (e) {
      return json({ error: "upstream", detail: String(e) }, 502);
    }
  },
};
