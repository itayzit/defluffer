# Privacy Policy — defluffer

_Last updated: 2026-06-25_

defluffer ("the extension") summarizes long LinkedIn posts into a
single line. This policy explains exactly what data it handles.

## What the extension does

When you browse `linkedin.com`, the extension reads the **visible text of feed
posts** and the **post author's name**, and sends them to our summarization
service so it can return a one-line summary that replaces the post text in your
browser. Promoted/sponsored posts are labeled "AD" locally and are **not** sent.

## Data we process

| Data | Why | Where it goes |
|------|-----|---------------|
| Post text + author name | To generate the one-line summary | Our Cloudflare Worker → Google Gemini API |
| A random install ID (e.g. `7f3a…`) | Anti-abuse rate limiting only — not tied to your identity | Our Cloudflare Worker |
| On/off toggle + install ID | Remember your preference | Stored locally in your browser (`chrome.storage`) |

We do **not** collect or transmit your name, email, LinkedIn profile, contacts,
browsing history, passwords, or any account credentials.

## Storage and retention

- The summarization service processes post text **in transit only** to produce a
  summary. We do not operate a database and do not retain post content.
- Post text is sent to Google's Gemini API, which processes it under
  [Google's API terms](https://ai.google.dev/gemini-api/terms). Do not use the
  extension on confidential information you would not paste into a third-party
  AI service.
- The install ID and toggle live in your browser's local extension storage and
  are removed when you uninstall the extension.

## What we never do

- No selling or sharing of data with third parties for advertising.
- No analytics, tracking pixels, or fingerprinting.
- No accounts, logins, or collection of personal information.

## Your choices

- Toggle the extension off anytime from its popup.
- Uninstalling removes all locally stored data.

## Contact

Questions? Email **itayzit@gmail.com**.
