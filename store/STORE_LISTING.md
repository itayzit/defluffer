# Chrome Web Store listing — defluffer

Copy/paste source for the Developer Dashboard listing + review answers.

## Name
defluffer

## Summary (≤132 chars)
Trims long, AI-fluffed LinkedIn posts to one honest line as you scroll. Less fluff, same feed.

## Category
Productivity

## Detailed description
Your LinkedIn feed is full of fluff. defluffer cuts it.

Long, AI-bloated posts collapse into one honest line as you scroll — "John
graduated from Stanford.", "Michael got promoted to VP." Everything else stays
put: author, photo, reactions, comments. Tap "show original" to bring the full
post back anytime.

Summaries match the post's language (Hebrew stays Hebrew). No account, no setup,
no API key — install and scroll.

Not affiliated with or endorsed by LinkedIn.

## Single purpose (review field)
The extension's single purpose is to summarize long posts in the LinkedIn feed
into a one-line summary shown in place of the original text.

## Permission justifications (review fields)

**`storage`**
Stores the user's on/off preference and a randomly generated install ID (used
only for anti-abuse rate limiting). No personal data.

**Host permission — `https://www.linkedin.com/*`**
The extension runs only on LinkedIn and reads visible feed-post text in order to
replace it with a summary. It does not run on any other site.

**Host permission — `https://*.workers.dev/*`**
The extension sends post text to our own Cloudflare Worker endpoint (on
workers.dev), which calls an AI model and returns the one-line summary.

## Data usage disclosures (Privacy practices tab)
- **What user data do you collect?** "Website content" (the text of LinkedIn
  posts the user views), processed to generate summaries.
- Not sold or shared with third parties.
- Not used for purposes unrelated to the single purpose.
- Not used for creditworthiness/lending.
- Privacy policy URL: https://itayzit.github.io/defluffer/privacy.html

## Assets checklist
- [x] Icon 128×128 (`icons/icon128.png`)
- [ ] 1–5 screenshots, 1280×800 (generated in `store/screenshots/`)
- [ ] Small promo tile 440×280 (optional)
- [ ] Privacy policy hosted at a public URL (GitHub Pages / gist works)

## Before you submit
1. Enable **billing** on the Google Cloud project behind the Gemini key, and set
   a **budget cap** (the public endpoint runs on your key).
2. Confirm `WORKER_URL` in `background.js` points to your deployed Worker.
3. Host `store/PRIVACY.md` somewhere public and paste the URL into the listing.
4. Zip the extension (see `store/build.sh`) and upload `dist/defluff.zip`.
5. $5 one-time Chrome Web Store developer registration if you haven't already.

Review usually takes 1–3 days; content scripts + host permissions can draw extra
scrutiny — the justifications above are written to clear it.
