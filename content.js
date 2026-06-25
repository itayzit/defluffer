// LinkedIn Defluffer — content script.
// Finds feed posts, sends their text to the background worker for a one-line
// summary, then swaps the post body for that summary. Everything else on the
// card (author, avatar, reactions, comments) stays exactly as it was.

const PROCESSED = "data-defluffed";
const MIN_CHARS = 180; // don't bother summarizing already-short posts

let enabled = true;

// After the extension is reloaded/updated, this already-injected script keeps
// running in the open tab but its chrome.* APIs are dead. Detect that so we go
// quiet instead of throwing "Extension context invalidated" on every mutation.
function contextAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

chrome.storage.sync.get({ enabled: true }, (s) => {
  enabled = s.enabled;
  if (enabled) scanAll();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    if (enabled) scanAll();
    else restoreAll();
  }
});

// --- DOM helpers -----------------------------------------------------------

// A post card in the main feed. LinkedIn's current feed uses a managed
// component framework with hashed class names, so we anchor on stable
// attributes (role, data-testid, componentkey) instead of CSS classes.
function findPosts() {
  return document.querySelectorAll('div[role="listitem"]');
}

// The element holding the actual post text inside a card.
function findTextEl(post) {
  return (
    post.querySelector('p[componentkey^="feed-commentary"]') ||
    post.querySelector('span[data-testid="expandable-text-box"]') ||
    // Legacy fallbacks in case LinkedIn serves an older layout.
    post.querySelector(".update-components-text") ||
    post.querySelector(".feed-shared-inline-show-more-text")
  );
}

function cleanText(s) {
  // Strip the trailing "…more" / "... more" affordance the feed appends.
  return s.replace(/[…\.]{1,3}\s*more\s*$/i, "").trim();
}

function findAuthor(post, textEl) {
  // The actor's name shows up in screen-reader strings like
  // "View Mansi Bhamu’s profile" on the avatar image alt or an aria-label.
  // A post can carry several: a "X commented/reposted" header on top, then the
  // actual poster just above the post text. We want the poster — i.e. the last
  // actor label that appears before the commentary in document order.
  const labels = [...post.querySelectorAll('img[alt^="View "], [aria-label^="View "]')];
  let pick = labels[0];
  if (textEl) {
    const before = labels.filter(
      (el) => el.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    if (before.length) pick = before[before.length - 1];
  }
  const label = pick?.getAttribute("alt") || pick?.getAttribute("aria-label") || "";
  const m = label.match(/View (.+?)[’'`]s profile/);
  if (m) return m[1].trim();

  // Fallback: actor link (closest before the text) with real visible text.
  const links = [...post.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')];
  const ordered = textEl
    ? links.filter((a) => a.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING).reverse()
    : links;
  for (const a of ordered) {
    const t = a.innerText.trim().split("\n")[0];
    if (t && !/^View /.test(t)) return t.slice(0, 60);
  }
  return "";
}

// --- Core ------------------------------------------------------------------

function scanAll() {
  if (!contextAlive()) return;
  findPosts().forEach(maybeDefluff);
}

function restoreAll() {
  document.querySelectorAll(`[${PROCESSED}]`).forEach((textEl) => {
    // The original text was never overwritten — just un-hide it and drop the
    // animation styles + the summary block.
    textEl.style.display = "";
    textEl.style.maxHeight = "";
    textEl.style.opacity = "";
    textEl.style.overflow = "";
    textEl.style.transition = "";
    textEl.__defluffSummaryEl?.remove();
    revealObserver.unobserve(textEl);
    delete textEl.__pendingSummary;
    delete textEl.__defluffIsAd;
    const badge = textEl.parentElement?.querySelector(".defluff-badge");
    badge?.remove();
    textEl.removeAttribute(PROCESSED);
  });
}

// A post is an ad if a "Promoted" / "Sponsored" label sits in its header (where
// the timestamp normally goes), above the post text. The label can be bare
// ("Promoted") or attributed ("Promoted by Acme"). We deliberately do NOT match
// "Promoted to VP…" so genuine promotion humblebrags still get summarized.
function isPromoted(post, textEl) {
  for (const el of post.querySelectorAll("span, div")) {
    const t = el.textContent.trim();
    if (t.length > 60) continue;
    if (!/^(Promoted|Sponsored)( by\b|$)/.test(t)) continue;
    if (!textEl) return true;
    if (el.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
  }
  return false;
}

function maybeDefluff(post) {
  const textEl = findTextEl(post);
  if (!textEl || textEl.hasAttribute(PROCESSED)) return;

  // Ads don't get summarized — just flagged as "AD" (regardless of length).
  if (isPromoted(post, textEl)) {
    textEl.setAttribute(PROCESSED, "pending");
    textEl.__defluffOriginal = textEl.innerHTML;
    textEl.__defluffIsAd = true;
    textEl.__pendingSummary = "AD";
    revealObserver.observe(textEl);
    return;
  }

  const text = cleanText(textEl.innerText);
  if (text.length < MIN_CHARS) return;

  textEl.setAttribute(PROCESSED, "pending");
  textEl.__defluffOriginal = textEl.innerHTML;

  const author = findAuthor(post, textEl);

  try {
    chrome.runtime.sendMessage(
      { type: "defluff", text, authorName: author },
      (res) => {
        if (chrome.runtime.lastError) {
          textEl.removeAttribute(PROCESSED);
          return;
        }
        if (!res || res.error) {
          textEl.removeAttribute(PROCESSED); // rate-limited / network / upstream — skip quietly
          return;
        }
        // Summary is ready, but hold the reveal until the post is scrolled into
        // view so it fades in right as the reader reaches it.
        textEl.__pendingSummary = res.summary;
        revealObserver.observe(textEl);
      }
    );
  } catch {
    // Extension context went away (reloaded/updated) — drop it quietly.
    textEl.removeAttribute(PROCESSED);
  }
}

// Fades the summary in when its post enters the viewport. The negative bottom
// margin means it triggers once the post is comfortably in view, not the
// instant its bottom edge peeks in.
const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const textEl = e.target;
      revealObserver.unobserve(textEl);
      if (textEl.getAttribute(PROCESSED) === "done") continue;
      if (textEl.__pendingSummary) revealSummary(textEl, textEl.__pendingSummary);
    }
  },
  { rootMargin: "0px 0px -120px 0px", threshold: 0 }
);

function revealSummary(textEl, summary) {
  textEl.setAttribute(PROCESSED, "done");

  // Build the summary block as a sibling so the original and the summary can
  // cross-fade. The summary line copies the post's own computed text styling,
  // so it matches LinkedIn exactly (and survives light/dark themes).
  const cs = getComputedStyle(textEl);
  const summaryEl = document.createElement("div");
  summaryEl.className = "defluff-summary";

  // Match the post's own horizontal insets — on LinkedIn the side padding
  // lives on the text element itself, so the summary must mirror it or it
  // runs flush to the card edges.
  summaryEl.style.paddingLeft = cs.paddingLeft;
  summaryEl.style.paddingRight = cs.paddingRight;

  const line = document.createElement("div");
  line.className = "defluff-line";
  line.textContent = summary;
  line.style.color = cs.color;
  line.style.fontSize = cs.fontSize;
  line.style.fontWeight = cs.fontWeight;
  line.style.lineHeight = cs.lineHeight;
  line.style.fontFamily = cs.fontFamily;

  const tag = textEl.__defluffIsAd ? "ad" : "defluffed";
  const badge = document.createElement("button");
  badge.className = "defluff-badge";
  badge.type = "button";
  badge.textContent = tag + " · show original";

  summaryEl.appendChild(line);
  summaryEl.appendChild(badge);
  textEl.__defluffSummaryEl = summaryEl;

  // Measure both heights before animating.
  const origH = textEl.offsetHeight;
  textEl.insertAdjacentElement("afterend", summaryEl);
  const sumH = summaryEl.offsetHeight;

  // Initial state: original fully shown, summary collapsed + hidden.
  textEl.style.overflow = "hidden";
  textEl.style.maxHeight = origH + "px";
  textEl.style.opacity = "1";
  summaryEl.style.overflow = "hidden";
  summaryEl.style.maxHeight = "0px";
  summaryEl.style.opacity = "0";
  void textEl.offsetHeight; // force a reflow so the transition runs

  // Cross-fade: original fades + collapses out, summary fades + expands in.
  textEl.style.transition = "max-height .45s ease, opacity .3s ease";
  summaryEl.style.transition = "max-height .45s ease, opacity .45s ease .08s";
  requestAnimationFrame(() => {
    textEl.style.maxHeight = "0px";
    textEl.style.opacity = "0";
    summaryEl.style.maxHeight = sumH + "px";
    summaryEl.style.opacity = "1";
    summaryEl.classList.add("defluff-flash"); // brief blue "marking" glow
  });

  // After the transition: hide the original outright and release the clamp so
  // the summary can reflow naturally (e.g. if the window resizes).
  setTimeout(() => {
    if (textEl.getAttribute(PROCESSED) !== "done") return;
    textEl.style.display = "none";
    summaryEl.style.maxHeight = "none";
    summaryEl.style.transition = "";
    summaryEl.classList.remove("defluff-flash");
  }, 700);

  let showing = false;
  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showing = !showing;
    textEl.style.transition = "";
    if (showing) {
      textEl.style.display = "";
      textEl.style.maxHeight = "none";
      textEl.style.opacity = "1";
      summaryEl.style.display = "none";
    } else {
      textEl.style.display = "none";
      summaryEl.style.display = "";
    }
    badge.textContent = showing
      ? (textEl.__defluffIsAd ? "show ad" : "show summary")
      : tag + " · show original";
  });
}

// --- Watch the feed (infinite scroll) --------------------------------------

let scanTimer = null;
const observer = new MutationObserver(() => {
  if (!contextAlive()) {
    observer.disconnect(); // stale script from a previous extension version
    return;
  }
  if (!enabled) return;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanAll, 400); // debounce against our own DOM edits
});
observer.observe(document.body, { childList: true, subtree: true });
