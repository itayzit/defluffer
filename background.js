// Service worker: forwards a post's text to our Cloudflare Worker, which calls
// Gemini Flash-Lite and returns a one-line summary. No API key lives here — the
// key is a secret on the Worker. We attach a random per-install id so the
// Worker can rate-limit fairly without any login.

const WORKER_URL = "https://linkedin-defluffer.defluffer.workers.dev";

async function getInstallId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function summarize(text, authorName, lang, mode) {
  const installId = await getInstallId();
  try {
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Install-Id": installId,
      },
      body: JSON.stringify({ text, author: authorName, lang, mode: mode || "" }),
    });

    if (!resp.ok) {
      return { error: `server-${resp.status}` };
    }
    const data = await resp.json();
    if (data.error) return { error: data.error };
    return { summary: (data.summary || "").trim(), fluff: data.fluff || "" };
  } catch (e) {
    return { error: "network", detail: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "defluff") {
    summarize(msg.text, msg.authorName, msg.lang, msg.mode).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === "breakage") {
    // Selector-drift canary: anonymous, content-free ping ({surface, version}
    // only) so drift shows up on the worker's /health before the reviews do.
    // Also mark the extension icon so the user sees something is off.
    const action = chrome.action || chrome.browserAction; // MV3 / Firefox MV2
    action?.setBadgeText({ text: "!" });
    action?.setBadgeBackgroundColor?.({ color: "#c93a38" });
    fetch(`${WORKER_URL}/breakage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: msg.surface || "feed",
        version: chrome.runtime.getManifest().version,
      }),
    }).catch(() => {});
  }
});
