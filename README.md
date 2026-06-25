# defluffer

Replaces long, AI-fluffed LinkedIn posts with one honest line, as you scroll.
"John graduated from Stanford." Done. Promoted posts just say **AD**.

The author, avatar, reactions, and comments stay untouched — only the wall of
text fades into a summary, with a **show original** toggle on each post.

## Architecture

```
extension (content.js → background.js)
        │  POST {text, author} + X-Install-Id
        ▼
Cloudflare Worker (worker/)  ──►  Gemini 2.5 Flash-Lite
        │  holds the Google API key as a secret
        │  rate-limits per install-id + IP
        ▼  { summary }
```

No API key ships in the extension — it lives as a secret on the Worker. Users
install and go; nothing to configure.

## Deploy the Worker

You need a [Cloudflare account](https://dash.cloudflare.com) and a
[Google AI Studio API key](https://aistudio.google.com/apikey) (free).

```bash
cd worker
npx wrangler login                      # authorize in the browser
npx wrangler deploy                     # creates the Worker, prints its URL
npx wrangler secret put GEMINI_API_KEY  # paste your Google AI Studio key
```

Copy the printed URL (e.g. `https://linkedin-defluffer.<you>.workers.dev`) into
`WORKER_URL` at the top of [`background.js`](background.js).

> First deploy may warn about a hard spend cap — set one on the Google account
> (AI Studio / Cloud console) so an open endpoint can't run up an unbounded bill.

## Load the extension

1. Open `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder (the repo root, not `worker/`)
3. Open https://www.linkedin.com/feed and scroll

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 config |
| `content.js` | feed scanning, scroll-triggered reveal, DOM swap |
| `background.js` | calls the Worker |
| `worker/worker.js` | Gemini Flash-Lite proxy + rate limiting |
| `worker/wrangler.toml` | Worker config |
| `popup.html/js` | on/off toggle |
| `styles.css` | summary + badge styling |
| `icons/` | extension icon (cloud + scissors) |

## Notes

- Summaries match the post's language (Hebrew post → Hebrew summary).
- Posts shorter than ~180 chars are left alone.
- LinkedIn changes its DOM class names periodically; if summaries stop
  appearing, the selectors in `findTextEl` / `findAuthor` are the place to look.
