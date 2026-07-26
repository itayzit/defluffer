<img src="icons/icon128.png" alt="defluffer logo" width="80" align="left" />

# defluffer

**Install: [Chrome](https://chromewebstore.google.com/detail/defluffer/ofaajilnnjfcinocgpljpmchpcnbhhln) · [Firefox](https://addons.mozilla.org/en-US/firefox/addon/defluffer/)** · [Landing page](https://itayzit.github.io/defluffer/)

<br clear="left" />

Replaces long, AI-fluffed LinkedIn posts with one honest line, as you scroll.
"John graduated from Stanford." Done.

- The model grades each post's fluff (LOW → PURE); the badge color follows.
  Pure engagement bait earns `defluffed 94% · see for yourself · really?`
- Already-short posts get a green `fluff not found` instead.
- **check fluff** in the post composer grades your own draft before you post.
- Ads never leave the browser — they get a spinner: `⠹ ad · Synergizing…`
- Hover a summary for the `haiku` button. You didn't hear it from me.

Author, reactions, and comments stay untouched; one tap restores any original.

## Architecture

```
extension (content.js → background.js)
        │  POST {text, author, lang, mode} + X-Install-Id
        ▼
Cloudflare Worker (worker/)  ──►  Gemini 2.5 Flash-Lite
        │  holds the Google API key as a secret
        │  rate-limits per install-id + IP
        ▼  { summary, fluff }
```

No API key ships in the extension; nothing is stored server-side. The prompt
lives in [`worker/prompt.mjs`](worker/prompt.mjs) — one source of truth shared
by the Worker and the offline eval harness (`eval/run-eval.mjs`, golden set of
real posts, kept local).

## Run your own

You need a [Cloudflare account](https://dash.cloudflare.com) and a
[Google AI Studio API key](https://aistudio.google.com/apikey) (free).

```bash
cd worker
npx wrangler login
npx wrangler deploy                     # prints your Worker URL
npx wrangler secret put GEMINI_API_KEY
```

Point `WORKER_URL` in [`background.js`](background.js) at the printed URL, then
`chrome://extensions` → Developer mode → **Load unpacked** → repo root.
Set a spend cap on the Google account — it's an open endpoint.

Firefox: `bash store/build-firefox.sh` builds an MV2 zip (same code, different
manifest — Firefox MV3 makes host permissions opt-in, which would strand new
installs).

## Notes

- Summaries match the post's language (Hebrew post → Hebrew summary, RTL-safe).
- Posts under ~180 chars are never sent anywhere.
- LinkedIn ships two DOM renderers with hashed class names; if summaries stop
  appearing, start at `findPosts` / `findTextEl` in `content.js`.

MIT licensed. Not affiliated with LinkedIn.
