// LinkedIn Defluffer — content script.
// Finds feed posts, sends their text to the background worker for a one-line
// summary, then swaps the post body for that summary. Everything else on the
// card (author, avatar, reactions, comments) stays exactly as it was.

const PROCESSED = "data-defluffed";
const MIN_CHARS = 180; // don't bother summarizing already-short posts

// Ads never leave the browser — we just slap an animated label on them: a live
// nod to Claude Code's spinner (braille frame ticking, gerund cycling), aimed at
// the AI-tooling crowd. Always keeps the word "ad" so it stays honest.
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const AD_VERBS = [
  "Monetizing",
  "Upselling",
  "Sponsoring",
  "Synergizing",
  "Retargeting",
  "Converting",
  "Influencing",
  "Optimizing",
];

// Drive the spinner on an ad's line: braille frame every 80ms, verb every ~3s.
// Self-cleans the moment LinkedIn recycles the node out of the DOM, so we never
// leak intervals as the feed virtualizes.
function startAdSpinner(line) {
  stopAdSpinner(line);
  let frame = 0;
  let ticks = 0;
  let verb = Math.floor(Math.random() * AD_VERBS.length);
  const render = () => {
    if (!line.isConnected) return stopAdSpinner(line);
    line.textContent = `${SPIN_FRAMES[frame]} ad · ${AD_VERBS[verb]}…`;
    frame = (frame + 1) % SPIN_FRAMES.length;
    if (++ticks % 38 === 0) verb = (verb + 1) % AD_VERBS.length;
  };
  render();
  line.__spinId = setInterval(render, 80);
}
function stopAdSpinner(line) {
  if (line && line.__spinId) {
    clearInterval(line.__spinId);
    line.__spinId = null;
  }
}

// Detect a post written in a non-Latin script we want to pin the output language
// for. Today that's Hebrew only (the validated bug). Rule: Hebrew letters exist
// AND are at least as common as Latin letters — survives a stray English word in
// a Hebrew post, and a lone Hebrew name in an English post. Returns "" otherwise
// so the model just matches the language on its own (e.g. English, Spanish).
function detectLang(text) {
  const heb = (text.match(/[֐-׿]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  return heb > 0 && heb >= lat ? "Hebrew" : "";
}

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

// The element(s) that actually carry LinkedIn's line-clamp. Two feed layouts
// exist: sometimes findTextEl's element IS the clamped `expandable-text-box`
// span; other times it's a `p[componentkey=feed-commentary]` wrapper whose CHILD
// span holds the clamp. Override both so the un-clamp never misses.
function clampTargets(textEl) {
  const t = [textEl];
  textEl.querySelectorAll('span[data-testid="expandable-text-box"]').forEach((s) => t.push(s));
  return t;
}

// Force a truncated post fully open. LinkedIn clamps long text with
// `-webkit-line-clamp` + an inline "…more" toggle; a synthetic click on that
// toggle doesn't fire its React handler, so we override the clamp directly
// (!important beats LinkedIn's class) and hide the now-dead native toggle.
function showFullText(textEl) {
  clampTargets(textEl).forEach((el) => {
    el.style.setProperty("-webkit-line-clamp", "unset", "important");
    el.style.setProperty("max-height", "none", "important");
    el.style.setProperty("overflow", "visible", "important");
  });
  textEl.querySelectorAll("button").forEach((b) => {
    if (/^…?\s*(see\s+)?(more|less)\s*$/i.test((b.innerText || "").trim())) {
      b.dataset.defluffHid = "1";
      b.style.display = "none";
    }
  });
}

// Undo showFullText — return the element(s) to LinkedIn's own clamped state.
function restoreClamp(textEl) {
  clampTargets(textEl).forEach((el) => {
    el.style.removeProperty("-webkit-line-clamp");
    el.style.removeProperty("max-height");
    el.style.removeProperty("overflow");
  });
  textEl.querySelectorAll('button[data-defluff-hid="1"]').forEach((b) => {
    b.style.display = "";
    delete b.dataset.defluffHid;
  });
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

// Only defluff on real feed surfaces — the home feed and single-post pages.
// The content script is injected on all of linkedin.com, but we must NOT touch
// text on other pages (invitation manager, messaging, notifications, jobs),
// where "posts" like a connection-request note would get wrongly summarized.
// LinkedIn is an SPA, so this is re-checked on every scan, not just at load.
function onFeedPage() {
  const p = location.pathname;
  return (
    p === "/feed/" ||
    p === "/feed" ||
    p.startsWith("/feed/update/") ||
    p.startsWith("/posts/")
  );
}

function scanAll() {
  if (!contextAlive() || !onFeedPage()) return;
  findPosts().forEach((post) => {
    // Guard each post so one unexpected DOM shape can't abort the whole sweep
    // and leave every post after it unprocessed.
    try {
      maybeDefluff(post);
    } catch {}
  });
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
    restoreClamp(textEl); // clear any full-text override + un-hide native toggles
    stopAdSpinner(textEl.__defluffSummaryEl?.querySelector(".defluff-line"));
    textEl.__defluffSummaryEl?.remove();
    revealObserver.unobserve(textEl);
    delete textEl.__pendingSummary;
    delete textEl.__defluffIsAd;
    delete textEl.__defluffOrigLen;
    delete textEl.__defluffLang;
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

  // Ads don't get summarized or sent anywhere — just slapped with a local,
  // rotating spinner-verb label (regardless of length).
  if (isPromoted(post, textEl)) {
    textEl.setAttribute(PROCESSED, "pending");
    textEl.__defluffOriginal = textEl.innerHTML;
    textEl.__defluffIsAd = true;
    textEl.__pendingSummary = "ad"; // sentinel; the line is animated, not static
    revealObserver.observe(textEl);
    return;
  }

  const text = cleanText(textEl.innerText);
  if (text.length < MIN_CHARS) return;

  textEl.setAttribute(PROCESSED, "pending");
  textEl.__defluffOriginal = textEl.innerHTML;
  textEl.__defluffOrigLen = text.length; // for the badge's "defluffed NN%" stat

  const author = findAuthor(post, textEl);
  const lang = detectLang(text);
  textEl.__defluffLang = lang; // the summary line's base direction follows the post

  try {
    chrome.runtime.sendMessage(
      { type: "defluff", text, authorName: author, lang },
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

  // For ads "the fluff" doesn't fit, so the ad just toggles show/hide — and its
  // line is an animated spinner, not static text.
  const isAd = textEl.__defluffIsAd;

  const line = document.createElement("div");
  line.className = "defluff-line";
  if (isAd) {
    // Seed a frame so the height measures right; startAdSpinner takes over once
    // the node is in the DOM. Force LTR — the label is English even on RTL ads.
    line.textContent = `${SPIN_FRAMES[0]} ad · ${AD_VERBS[0]}…`;
    line.style.direction = "ltr";
    line.style.textAlign = "left";
  } else {
    line.textContent = summary;
    // A Hebrew summary often embeds Latin runs ("...כ-Senior Product Designer").
    // Without a declared base direction the line inherits the page's LTR and the
    // bidi algorithm scrambles the pieces. dir="auto" isn't enough either: it
    // reads the FIRST strong character, so a Hebrew summary that opens with a
    // Latin name ("OpenWiki Brains בונה...") still resolves LTR and scrambles.
    // We know the post's language from the request, so set the base direction
    // explicitly; text-align:start then aligns to the reading side.
    line.setAttribute("dir", textEl.__defluffLang === "Hebrew" ? "rtl" : "auto");
    line.style.textAlign = "start";
  }
  line.style.color = cs.color;
  line.style.fontSize = cs.fontSize;
  line.style.fontWeight = cs.fontWeight;
  line.style.lineHeight = cs.lineHeight;
  line.style.fontFamily = cs.fontFamily;

  // How much text the summary cut, as the badge's headline stat. The pill's
  // color heats up with the number — the redder the pill, the fluffier the
  // post was. Below 40% the number is more embarrassing than impressive, so
  // the badge stays plain (and blue).
  let defluffedLabel = isAd ? "show the ad" : "defluffed · show fluff";
  let badgeTier = "";
  if (!isAd && textEl.__defluffOrigLen > 0) {
    const pct = Math.round((1 - summary.length / textEl.__defluffOrigLen) * 100);
    if (pct >= 95) {
      defluffedLabel = `defluffed ${pct}% · see for yourself · really?`;
      badgeTier = "defluff-badge--hot";
    } else if (pct >= 90) {
      defluffedLabel = `defluffed ${pct}% · show fluff`;
      badgeTier = "defluff-badge--hot";
    } else if (pct >= 65) {
      defluffedLabel = `defluffed ${pct}% · show fluff`;
      badgeTier = "defluff-badge--warm";
    } else if (pct >= 40) {
      defluffedLabel = `defluffed ${pct}% · show fluff`;
    }
  }
  const originalLabel = isAd ? "hide the ad" : "fluff · defluff it";
  const badge = document.createElement("button");
  badge.className = badgeTier ? `defluff-badge ${badgeTier}` : "defluff-badge";
  badge.type = "button";
  badge.textContent = defluffedLabel;

  summaryEl.appendChild(line);
  summaryEl.appendChild(badge);
  textEl.__defluffSummaryEl = summaryEl;

  // Measure both heights before animating.
  const origH = textEl.offsetHeight;
  textEl.insertAdjacentElement("afterend", summaryEl);
  const sumH = summaryEl.offsetHeight;
  if (isAd) startAdSpinner(line); // node is in the DOM now — animate the label

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
      // Show original: bring the post text back (the reveal timeout parked it at
      // display:none), and hide ONLY the summary line — keep summaryEl in flow so
      // the badge stays clickable. This is the fix for the old one-way door.
      textEl.style.display = "";
      textEl.style.opacity = "1";
      // Long posts are truncated by LinkedIn with `-webkit-line-clamp` + a native
      // "…more" toggle *inside* the text element. Hiding the element during the
      // defluff animation makes LinkedIn strip that toggle, so restoring it would
      // leave a clamped post with no way to expand. Override the clamp ourselves
      // (a synthetic click doesn't fire LinkedIn's React handler) and hide the now
      // dead native toggle so the full post is always readable here.
      showFullText(textEl);
      line.style.display = "none";
      if (isAd) stopAdSpinner(line); // no need to animate a hidden label
    } else {
      // Back to defluffed: hide the original, show the summary line again.
      textEl.style.display = "none";
      line.style.display = "";
      if (isAd) startAdSpinner(line);
    }
    badge.textContent = showing ? originalLabel : defluffedLabel;
  });
}

// --- Watch the feed (infinite scroll) --------------------------------------
//
// A plain debounce is the wrong tool here: LinkedIn mutates the feed constantly
// while you scroll (lazy media, live UI, virtualization), which kept resetting
// the timer so posts that loaded mid-scroll were never scanned. Instead we
// THROTTLE — scan on the leading edge, then at most every 500ms — so a steady
// mutation stream can't starve it. A periodic safety-net scan guarantees any
// post the observer missed still gets picked up within ~1.5s.

let scanTimer = null;
let lastScan = 0;
function scheduleScan() {
  const since = Date.now() - lastScan;
  clearTimeout(scanTimer);
  if (since >= 500) {
    lastScan = Date.now();
    scanAll();
  } else {
    scanTimer = setTimeout(() => {
      lastScan = Date.now();
      scanAll();
    }, 500 - since);
  }
}

function teardown() {
  observer.disconnect();
  clearInterval(safetyNet);
}

const observer = new MutationObserver(() => {
  if (!contextAlive()) return teardown(); // stale script from a previous version
  if (enabled) scheduleScan();
});
observer.observe(document.body, { childList: true, subtree: true });

// Safety net: even if the observer misses a mutation batch, sweep the whole
// feed every 1.5s (cheap — scanAll dedupes on the data-defluffed attribute).
const safetyNet = setInterval(() => {
  if (!contextAlive()) return teardown();
  if (enabled) scanAll();
}, 1500);
