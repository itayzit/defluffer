// Golden-set evaluator for the defluff prompt.
//
// Runs every post in golden-set.jsonl through the SAME prompt the Worker ships
// (imported from ../worker/prompt.js) and writes a CSV you can open in Google
// Sheets / Excel, rate, and hand back. Then we tune prompt.js and re-run.
//
// Two ways to run (pick one):
//
//   1. Against the deployed Worker (no API key needed — it's public):
//        node eval/run-eval.mjs --endpoint https://linkedin-defluffer.defluffer.workers.dev
//
//   2. Against Gemini directly, testing your LOCAL prompt.js without deploying
//      (faster iteration). Put your key in your OWN shell env first:
//        export GEMINI_API_KEY=...        # never commit this
//        node eval/run-eval.mjs
//
// Output: eval/results-<timestamp>.csv  (columns include empty rating + notes
// for you to fill in).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MODEL,
  MAX_INPUT_CHARS,
  SYSTEM_PROMPT,
  GENERATION_CONFIG,
  buildUserContent,
  detectLang,
} from "../worker/prompt.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = 2; // gentle on rate limits / model overload
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini throws 503 "high demand" and 429 under load — transient, worth a retry.
function isTransient(err) {
  return (
    /\b(429|500|502|503|504)\b/.test(err) ||
    /high demand|overloaded|unavailable|try again/i.test(err) ||
    err === "network" ||
    /^http-5/.test(err)
  );
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const endpoint = arg("--endpoint") || process.env.WORKER_URL || "";
const apiKey = process.env.GEMINI_API_KEY || "";

if (!endpoint && !apiKey) {
  console.error(
    "No target. Either pass --endpoint <worker-url>, or set GEMINI_API_KEY in your env.\n" +
      "  node eval/run-eval.mjs --endpoint https://linkedin-defluffer.defluffer.workers.dev\n" +
      "  GEMINI_API_KEY=... node eval/run-eval.mjs"
  );
  process.exit(1);
}

const mode = endpoint ? `worker (${endpoint})` : `gemini direct (${MODEL})`;

// --- summarizers ----------------------------------------------------------

async function viaWorker(post, lang) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Install-Id": "eval-harness" },
    body: JSON.stringify({ text: post.text, author: post.author, lang }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) return { error: data.error || `http-${resp.status}` };
  return { summary: (data.summary || "").trim() };
}

async function viaGemini(post, lang) {
  const text = post.text.slice(0, MAX_INPUT_CHARS).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: buildUserContent(text, post.author, lang) }] }],
      generationConfig: GENERATION_CONFIG,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { error: `api-${resp.status}: ${JSON.stringify(data).slice(0, 160)}` };
  const summary = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  return summary ? { summary } : { error: "no-summary" };
}

const summarize = endpoint ? viaWorker : viaGemini;

// --- CSV ------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

// --- run ------------------------------------------------------------------

const posts = readFileSync(join(__dir, "golden-set.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

console.log(`Running ${posts.length} posts via ${mode}, concurrency ${CONCURRENCY}…`);

const results = new Array(posts.length);
let next = 0;
async function worker() {
  while (next < posts.length) {
    const i = next++;
    const post = posts[i];
    const lang = detectLang(post.text);
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await summarize(post, lang);
      } catch (e) {
        r = { error: String(e) };
      }
      if (!r.error || !isTransient(r.error) || attempt >= MAX_RETRIES) break;
      process.stdout.write("r"); // retrying
      await sleep(800 * 2 ** attempt + Math.floor(Math.random() * 400));
    }
    results[i] = { ...post, lang, after: r.summary || `⚠ ${r.error}` };
    process.stdout.write(r.error ? "x" : ".");
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n");

const header = ["id", "category", "lang", "author", "link", "before", "after", "rating (1-5)", "notes"];
const rows = results.map((r) =>
  csvRow([r.id, r.category, r.lang || "—", r.author, r.url || "", r.text, r.after, "", ""])
);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = join(__dir, `results-${stamp}.csv`);
// UTF-8 BOM so Excel reads Hebrew correctly.
writeFileSync(outPath, "﻿" + csvRow(header) + "\n" + rows.join("\n") + "\n");

const errs = results.filter((r) => r.after.startsWith("⚠")).length;
console.log(`Done. ${results.length - errs} ok, ${errs} errors.`);
console.log(`CSV: ${outPath}`);
