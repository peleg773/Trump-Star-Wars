/* ============================================================
   Culture Wars — Trump Truth Social Star Wars crawl
   ============================================================ */

const ARCHIVE_URL = 'https://ix.cnn.io/data/truth-social/truth_archive.json';

const SPEED_PX_PER_SEC = 55;
// Mobile viewports are shorter, so the same px/sec consumes more screen
// per second than on desktop. Scale the crawl speed down on narrow
// screens so the *perceived* pace (viewport-heights per second) matches.
const MOBILE_SPEED_FACTOR = 0.7;
const MOBILE_WIDTH_THRESHOLD = 640;

function currentCrawlSpeed() {
  return window.innerWidth <= MOBILE_WIDTH_THRESHOLD
    ? SPEED_PX_PER_SEC * MOBILE_SPEED_FACTOR
    : SPEED_PX_PER_SEC;
}

function currentCrawlLogoOverlapMs() {
  return window.innerWidth <= MOBILE_WIDTH_THRESHOLD
    ? MOBILE_CRAWL_LOGO_OVERLAP_MS
    : CRAWL_LOGO_OVERLAP_MS;
}
// Keep already-passed posts in the DOM well beyond the top fade band so
// reverse scrolling never inserts text while it is still visible.
const RENDER_BEHIND_VIEWPORTS = 10;
const RENDER_AHEAD_VIEWPORTS = 7;
const WHEEL_DELTA_STEP_PX = 110;
const WHEEL_MAX_STEPS = 3;
// Desktop wheel/trackpad scrub distance per accepted scroll step, expressed
// as a fraction of the viewport height. Raise/lower this to tune how far a
// wheel gesture moves the crawl.
const WHEEL_JUMP_VIEWPORTS = 0.085;
// Exact empty space inserted between consecutive crawl items. It is applied
// in the prefix-sum layout, not as CSS margin, so every post-to-post gap is
// numerically identical.
const POST_GAP_VIEWPORTS = 0.25;
const POST_GAP_MOBILE_SCALE = 1;
const POST_GAP_SMALL_MOBILE_SCALE = 0.9;
const TOUCH_DRAG_GAIN = 1.4;       // finger-pixel → crawl-pixel multiplier
const TOUCH_FLICK_MAX_PX_S = 4200; // cap on flick momentum velocity
const TOUCH_FLICK_DECAY = 4.5;     // momentum decay rate per second
const TOUCH_FLICK_MIN_VELOCITY = 40;
const MIN_TEXT_CHARS   = 1;
const FETCH_TIMEOUT_MS = 12000;
// Toggle the orange highlight on trailing Trump signatures ("DJT",
// "DONALD J. TRUMP", etc.). Flip to false to render those names in the
// default crawl yellow.
const HIGHLIGHT_TRUMP_SIGNATURE = false;

const INTRO_TAGLINE_MS = 5000;
const INTRO_LOGO_MS    = 7500;
const INTRO_GAP_MS     = 300;
// The crawl element appears partway through the logo recession so the
// text has time to actually travel into the viewport from below. The
// 12vh starting offset (see CSS) plus the constant 55 px/s climb means
// the first line takes ~1–2 s to clear the screen edge depending on
// viewport height; we need that lead time to baked into the overlap.
const CRAWL_LOGO_OVERLAP_MS = 6600;
const CRAWL_MOBILE_DESKTOP_DIFF = 10000;
const MOBILE_CRAWL_LOGO_OVERLAP_MS = CRAWL_LOGO_OVERLAP_MS - CRAWL_MOBILE_DESKTOP_DIFF;

const TAGLINE = 'Not a long time ago, in a galaxy not far, far away...';
const FONT_LOAD_SAMPLE = 'EPISODE MAY 17, 2026 DONALD J. TRUMP TRANSMISSION';

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)(\?|$|#)/i;

/* ---------- Helpers ---------- */

function toRoman(num) {
  if (num <= 0) return '';
  const map = [
    ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
    ['C', 100],  ['XC', 90],  ['L', 50],  ['XL', 40],
    ['X', 10],   ['IX', 9],   ['V', 5],   ['IV', 4],
    ['I', 1]
  ];
  let n = num, out = '';
  for (const [sym, val] of map) {
    while (n >= val) { out += sym; n -= val; }
  }
  return out;
}

function decodeAndStrip(html) {
  if (!html) return '';
  // DOMParser handles entities AND tags in one shot.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Preserve paragraph breaks: replace block elements with double-newline,
  // <br> with single newline, then collapse.
  doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  doc.querySelectorAll('p, div').forEach(el => {
    el.append('\n\n');
  });
  return doc.body.textContent
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePostText(text) {
  return text
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasLink(rawHtml, text) {
  return /<a\b/i.test(rawHtml) ||
    /\b(?:https?:\/\/|www\.|truthsocial\.com\/)\S+/i.test(text) ||
    /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+\.(?:com|org|net|gov|edu|io|co|us|news|media|tv|me|ly)(?:\/\S*)?/i.test(text);
}

function isRetweet(text) {
  return /^RT(?:\s|:|@)/i.test(text);
}

/* ---------- Sentence splitting -----------------------------------------

   The Truth Social archive is full of sentence-splitter landmines:
   U.S., F.B.I., Mr. Trump, decimal numbers, ellipses, all-caps emphasis.
   Both Intl.Segmenter and the regex fallback can be fooled, so the
   strategy is to mask every period that is NOT a real sentence terminator
   with a private-use code point before segmentation, then restore them.

   Two complementary protectors:
     1. A *generic* pattern  `(letter.)(letter.)+`  which catches any
        acronym written as repeated letter-plus-period, even ones we
        haven't enumerated (U.S., F.B.I., A.O.C., J.D., etc).
     2. A *named* list of single-token abbreviations (Mr., Dr., etc.,
        Inc.) which the generic pattern can't reach because they have
        more than one letter before the dot.

   Plus: decimals, ellipses, and "Initial. Surname" name patterns.

   Finally `cleanSentenceBreaks` runs a lowercase-continuation safety net:
   real English sentences don't start with a lowercase letter, so a split
   that produced one is almost certainly a missed abbreviation and gets
   merged back. ------------------------------------------------------- */

const DOT_SENTINEL = '';

const ABBREVIATIONS = [
  // Geo / political — also covered by the generic acronym pattern, but
  // listed for clarity and because some are < 2 tokens.
  'U.S.A.', 'U.S.', 'U.K.', 'U.N.', 'E.U.', 'D.C.',
  'N.Y.', 'L.A.', 'N.J.', 'N.H.', 'P.R.',
  // Agencies & departments
  'F.B.I.', 'C.I.A.', 'D.O.J.', 'I.R.S.', 'D.O.D.', 'N.S.A.',
  'E.P.A.', 'F.A.A.', 'F.D.A.', 'I.C.E.', 'A.T.F.', 'D.H.S.',
  // Honorifics & titles
  'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Sr.', 'Jr.', 'St.',
  'Pres.', 'Gov.', 'Sen.', 'Rep.', 'Gen.', 'Capt.', 'Lt.', 'Col.',
  'Sgt.', 'Adm.', 'Maj.', 'Cmdr.',
  // Address
  'Ave.', 'Blvd.', 'Rd.',
  // Business
  'Inc.', 'Co.', 'Ltd.', 'Corp.',
  // Latin / shorthand
  'vs.', 'etc.', 'i.e.', 'e.g.', 'cf.', 'al.',
  // Time
  'a.m.', 'p.m.',
  // Misc
  'No.',
];

// Build a case-insensitive alternation, longest first so 'U.S.A.' beats
// 'U.S.' when both could match.
const ABBR_RE = new RegExp(
  '\\b(?:' +
    ABBREVIATIONS
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(a => a.replace(/\./g, '\\.'))
      .join('|') +
  ')',
  'gi'
);

function protectAbbreviations(text) {
  return text
    // 1. Generic multi-letter acronyms: U.S., F.B.I., U.S.A., J.D., A.O.C.
    .replace(/\b(?:[A-Za-z]\.){2,}/g, m => m.replace(/\./g, DOT_SENTINEL))
    // 2. Known single-token abbreviations: Mr., Dr., etc., Inc., a.m.
    .replace(ABBR_RE, m => m.replace(/\./g, DOT_SENTINEL))
    // 3. Decimal numbers and section refs: 1.5, 1.2.3, $99.99
    //    Lookahead keeps overlapping cases (1.2.3) intact.
    .replace(/(\d)\.(?=\d)/g, '$1' + DOT_SENTINEL)
    // 4a. Single-letter initial followed by another single-letter initial
    //     ("J. D. Vance"). Without this, "J." would be left as a fragment.
    .replace(/\b([A-Z])\.(?=\s+[A-Z]\.)/g, '$1' + DOT_SENTINEL)
    // 4b. "Initial. Surname" — capital + dot + (cap+lowercase word) or
    //     (ALLCAPS word). Catches "J. Trump", "F. Scott", "J. TRUMP".
    .replace(/\b([A-Z])\.(?=\s+[A-Z][a-zA-Z]{2,}\b)/g, '$1' + DOT_SENTINEL)
    // 5. Ellipses: ASCII run of 2+ dots, or the Unicode horizontal ellipsis.
    //    These are mid-sentence pauses, never terminators.
    .replace(/\.{2,}/g, m => DOT_SENTINEL.repeat(m.length))
    .replace(/…/g, DOT_SENTINEL.repeat(3));
}

function restoreDots(s) {
  return s.split(DOT_SENTINEL).join('.');
}

function cleanSentenceBreaks(sentences) {
  const out = [];
  for (const sentence of sentences) {
    const previous = out[out.length - 1];
    if (!previous) {
      out.push(sentence);
      continue;
    }
    // Safety net: a real English sentence never starts with a lowercase
    // letter, so a split that produced one is almost certainly a missed
    // abbreviation. Glue it back.
    if (/^[a-z]/.test(sentence)) {
      out[out.length - 1] = `${previous} ${sentence}`;
      continue;
    }
    // Historical-specific safety net for "J. TRUMP" if it somehow slipped
    // through both protectors above (e.g. weird whitespace).
    if (/\bJ\.$/.test(previous) && /^TRUMP\b/.test(sentence)) {
      out[out.length - 1] = `${previous} ${sentence}`;
      continue;
    }
    out.push(sentence);
  }
  return out;
}

// Insert a space at typo'd sentence boundaries: a 2+ letter word
// followed by a period and immediately a capital letter, no space in
// between ("Amendment.Election"). Done *before* abbreviation masking so
// that genuine "Mr.Smith"-style abbreviations still get masked normally
// after the space is inserted ("Mr. Smith" → "Mr<sentinel> Smith"). The
// `[a-zA-Z]{2,}` lookbehind keeps decimals (1.5) and single-letter
// initials (I. Said) safe.
function insertMissingSpaces(text) {
  return text.replace(/(?<=[a-zA-Z]{2})\.(?=[A-Z])/g, '. ');
}

function splitSentences(text) {
  if (!text) return [];

  const masked = protectAbbreviations(insertMissingSpaces(text));

  let segments;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    segments = Array.from(segmenter.segment(masked), part => part.segment);
  } else {
    segments = masked.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [];
  }

  return cleanSentenceBreaks(
    segments
      .map(s => restoreDots(s).trim())
      .filter(Boolean)
  );
}

/* ---------- Signature detection ----------
   A lot of posts close with a Trump signature: "DJT", "Donald J. TRUMP",
   "President DONALD J. TRUMP", etc. We highlight the name (NOT the
   "President" honorific) in orange — but only when the name terminates
   a sentence, so mid-text mentions of "Trump" aren't colored.

   Anchored to end-of-sentence by requiring the tail to contain nothing
   but whitespace and closing punctuation. The optional "Donald [J.]"
   prefix is part of the captured name; "President" (if present) stays
   in the unhighlighted prefix.                                          */

const SIGNATURE_END_RE =
  /^(.*?)\s*\b((?:Donald\s+(?:J\.?\s+)?)?(?:Trump|DJT))\s*([.!?…\s"')\]]*)$/i;

function classifyMedia(url) {
  if (typeof url !== 'string') return 'other';
  if (VIDEO_EXT_RE.test(url)) return 'video';
  return 'other';
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'long', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit'
});

function formatDateLine(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // "May 16, 2026, 5:41 PM" -> "MAY 16, 2026 — 5:41 PM"
  const parts = DATE_FMT.formatToParts(d);
  const get = type => {
    const p = parts.find(x => x.type === type);
    return p ? p.value : '';
  };
  const month  = get('month').toUpperCase();
  const day    = get('day');
  const year   = get('year');
  const hour   = get('hour');
  const minute = get('minute');
  const dp     = get('dayPeriod').toUpperCase();
  return `${month} ${day}, ${year} — ${hour}:${minute} ${dp}`;
}

/* ---------- Data layer ---------- */

async function fetchAndPrepare() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let raw;
  try {
    const res = await fetch(ARCHIVE_URL, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Archive fetch failed: ${res.status}`);
    raw = await res.json();
  } finally {
    clearTimeout(timeout);
  }

  if (!Array.isArray(raw)) {
    throw new Error('Archive response was not a list of transmissions');
  }

  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const rawContent = r.content || '';
    const media = Array.isArray(r.media) ? r.media : [];

    // Skip if any video is attached.
    if (media.some(u => classifyMedia(u) === 'video')) continue;

    const text = normalizePostText(decodeAndStrip(rawContent));
    if (isRetweet(text) || hasLink(rawContent, text)) continue;
    if (text.length < MIN_TEXT_CHARS) continue;

    out.push({
      id: r.id,
      url: typeof r.url === 'string' && r.url ? r.url : '',
      dateLine: formatDateLine(r.created_at),
      body: text,
      sentences: splitSentences(text)
    });
  }

  // Source is already newest-first; assign episode I = newest qualifying.
  out.forEach((p, idx) => { p.episode = toRoman(idx + 1); });
  return out;
}

/* ---------- Rendering ---------- */

function appendSentenceLines(p, sentence) {
  const sig = HIGHLIGHT_TRUMP_SIGNATURE ? sentence.match(SIGNATURE_END_RE) : null;

  // Non-signature sentences (or signature highlighting disabled):
  // simple line-by-line rendering.
  if (!sig || !sig[2]) {
    for (const line of balanceSentenceLines(sentence)) {
      const span = document.createElement('span');
      span.className = 'line';
      span.textContent = line;
      p.appendChild(span);
    }
    return;
  }

  // Signature sentence: glue the name with NBSPs so the balancer keeps
  // "DONALD J. TRUMP" on a single line, then split the rendered line at
  // the name boundary so we can wrap it in its own span.
  const NBSP = ' ';
  const prefix = sig[1];
  const nameRaw = sig[2];
  const tail   = sig[3];
  const nameNbsp = nameRaw.replace(/\s+/g, NBSP);
  const reconstructed = (prefix ? prefix + ' ' : '') + nameNbsp + tail;

  const lines = balanceSentenceLines(reconstructed);
  for (const line of lines) {
    const span = document.createElement('span');
    span.className = 'line';

    const idx = line.indexOf(nameNbsp);
    if (idx === -1) {
      span.textContent = line.replace(/ /g, ' ');
    } else {
      const before = line.slice(0, idx).replace(/ /g, ' ');
      const after  = line.slice(idx + nameNbsp.length).replace(/ /g, ' ');

      if (before) span.appendChild(document.createTextNode(before));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'trump-signature';
      nameSpan.textContent = nameRaw;
      span.appendChild(nameSpan);
      if (after) span.appendChild(document.createTextNode(after));
    }

    p.appendChild(span);
  }
}

function makePostEl(post) {
  const section = document.createElement('section');
  section.className = 'post';

  const episode = document.createElement(post.url ? 'a' : 'p');
  episode.className = 'episode';
  episode.textContent = `EPISODE ${post.episode}`;
  if (post.url) {
    episode.href = post.url;
    episode.target = '_blank';
    episode.rel = 'noopener noreferrer';
  }
  section.appendChild(episode);

  const title = document.createElement('h2');
  title.className = 'title';
  title.textContent = post.dateLine;
  section.appendChild(title);

  const body = document.createElement('div');
  body.className = 'body';
  const sentences = post.sentences && post.sentences.length ? post.sentences : splitSentences(post.body);
  for (const sentence of sentences) {
    const p = document.createElement('p');
    appendSentenceLines(p, sentence);
    body.appendChild(p);
  }
  section.appendChild(body);

  return section;
}

function makeEndCardEl() {
  const section = document.createElement('section');
  section.className = 'post end-card';
  section.textContent = 'TRANSMISSION ENDS';
  return section;
}

function makeCrawlItemEl(item) {
  return item.type === 'end' ? makeEndCardEl() : makePostEl(item.post);
}

function getLineCharLimit() {
  // CSS rule: width: min(88vw, 920px); font: clamp(1.4rem, 3.4vw, 2.8rem).
  // Approximate the rendered glyph width as ~0.42× the resolved font size,
  // which keeps lines visually similar from phone to desktop.
  const crawlWidth = Math.min(window.innerWidth * 0.88, 920);
  const fluidPx = 0.034 * window.innerWidth;  // 3.4vw in px
  const fontPx = clampNumber(fluidPx, 1.4 * 16, 2.8 * 16);
  const approxCharWidth = fontPx * 0.42;
  return clampNumber(Math.floor(crawlWidth / approxCharWidth), 18, 56);
}

function countLineChars(words, start, end) {
  let count = 0;
  for (let i = start; i < end; i++) {
    count += words[i].length;
  }
  return count + Math.max(0, end - start - 1);
}

function balanceSentenceLines(sentence) {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  const maxChars = getLineCharLimit();

  if (words.length <= 1 || sentence.length <= maxChars) {
    return [sentence];
  }

  const lineCount = clampNumber(Math.ceil(sentence.length / maxChars), 1, words.length);
  const lines = [];
  let start = 0;

  for (let lineIndex = 0; lineIndex < lineCount - 1; lineIndex++) {
    const linesLeft = lineCount - lineIndex;
    const wordsLeft = words.length - start;
    const target = Math.ceil(countLineChars(words, start, words.length) / linesLeft);
    const maxEnd = words.length - (linesLeft - 1);

    let bestEnd = start + 1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let end = start + 1; end <= maxEnd; end++) {
      const length = countLineChars(words, start, end);
      const remainingWords = wordsLeft - (end - start);
      const score = Math.abs(length - target) + (length > maxChars ? length - maxChars : 0) * 3;

      if (remainingWords < linesLeft - 1) break;
      if (score <= bestScore) {
        bestScore = score;
        bestEnd = end;
      }
    }

    lines.push(words.slice(start, bestEnd).join(' '));
    start = bestEnd;
  }

  lines.push(words.slice(start).join(' '));
  return lines;
}

function wheelDeltaToPixels(event, viewport) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 32;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * viewport.clientHeight;
  return event.deltaY;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function currentPostGapScale() {
  if (window.innerWidth <= 380) return POST_GAP_SMALL_MOBILE_SCALE;
  if (window.innerWidth <= MOBILE_WIDTH_THRESHOLD) return POST_GAP_MOBILE_SCALE;
  return 1;
}

function currentPostGapPx(viewport) {
  // Whole CSS pixels keep browser subpixel quantization from distributing
  // tiny remainders differently between different-height posts.
  return Math.round(viewport.clientHeight * POST_GAP_VIEWPORTS * currentPostGapScale());
}

function buildPrefixSums(heights, gapPx) {
  const prefix = [0];
  for (let i = 0; i < heights.length; i++) {
    const gapAfter = i < heights.length - 1 ? gapPx : 0;
    prefix.push(prefix[prefix.length - 1] + heights[i] + gapAfter);
  }
  return prefix;
}

function findItemIndexAt(prefix, offset) {
  if (offset <= 0) return 0;

  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (prefix[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return Math.min(lo, prefix.length - 2);
}

function measureCrawlItems(items) {
  const probe = document.createElement('div');
  probe.className = 'crawl-measure';
  document.body.appendChild(probe);

  const heights = items.map(item => {
    const el = makeCrawlItemEl(item);
    probe.appendChild(el);
    const height = el.getBoundingClientRect().height;
    el.remove();
    return height;
  });

  probe.remove();
  return heights;
}

async function waitForFonts() {
  if (!document.fonts || !document.fonts.ready) return;

  const requestedFonts = [
    document.fonts.load('48px "Pathway Gothic One"', FONT_LOAD_SAMPLE),
    document.fonts.load('16px "News Cycle"', FONT_LOAD_SAMPLE),
    document.fonts.ready
  ].map(promise => promise.catch(() => null));

  await Promise.race([
    Promise.all(requestedFonts),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
}

/* ---------- Crawl engine: windowed rAF ---------- */

function startCrawl(posts) {
  const crawl = document.getElementById('crawl');
  const viewport = document.getElementById('crawl-viewport');
  const items = posts.map(post => ({ type: 'post', post })).concat({ type: 'end' });

  let postGapPx = currentPostGapPx(viewport);
  let heights = measureCrawlItems(items);
  let prefix = buildPrefixSums(heights, postGapPx);
  let totalHeight = prefix[prefix.length - 1];
  let displayOffset = 0;
  let wheelRemainder = 0;
  let renderedStart = -1;
  let renderedEnd = -1;
  let isSelectingText = false;
  const renderedItems = new Map();
  let lastT = performance.now();

  // Touch scrub state
  let activeTouchId = null;
  let touchLastY = 0;
  let touchLastT = 0;
  let touchMoved = false;
  let touchVelocity = 0;       // px/sec, signed: positive = forward
  let flickVelocity = 0;       // current momentum
  let lastMeasuredWidth = window.innerWidth;
  let lastMeasuredHeight = viewport.clientHeight;

  function maxScrollOffset() {
    return totalHeight + viewport.clientHeight * 1.1;
  }

  function clampOffset(offset) {
    return Math.max(0, Math.min(maxScrollOffset(), offset));
  }

  function calculateRange() {
    const behind = viewport.clientHeight * RENDER_BEHIND_VIEWPORTS;
    const ahead = viewport.clientHeight * RENDER_AHEAD_VIEWPORTS;
    const start = findItemIndexAt(prefix, displayOffset - behind);
    const end = Math.min(items.length, findItemIndexAt(prefix, displayOffset + ahead) + 2);
    return { start, end: Math.max(end, start + 1) };
  }

  function renderRange() {
    const { start, end } = calculateRange();
    if (start === renderedStart && end === renderedEnd) return;

    const activeIndexes = new Set();
    for (let i = start; i < end; i++) {
      activeIndexes.add(i);
      let el = renderedItems.get(i);
      if (!el) {
        el = makeCrawlItemEl(items[i]);
        el.style.position = 'absolute';
        el.style.left = '0';
        el.style.width = '100%';
        el.dataset.crawlIndex = String(i);
        renderedItems.set(i, el);
        insertRenderedItem(i, el);
      }
      el.style.top = `${prefix[i]}px`;
    }

    if (!isSelectingText) {
      for (const [index, el] of renderedItems) {
        if (!activeIndexes.has(index)) {
          el.remove();
          renderedItems.delete(index);
        }
      }
    }

    renderedStart = start;
    renderedEnd = end;
  }

  function insertRenderedItem(index, el) {
    let nextEl = null;
    for (let i = index + 1; i < items.length; i++) {
      const candidate = renderedItems.get(i);
      if (candidate && candidate.parentNode === crawl) {
        nextEl = candidate;
        break;
      }
    }
    crawl.insertBefore(el, nextEl);
  }

  function applyTransform() {
    crawl.style.transform =
      `translateX(-50%) rotateX(25deg) translateY(${-displayOffset}px)`;
  }

  function syncScrollState() {
    displayOffset = clampOffset(displayOffset);
    renderRange();
    applyTransform();
  }

  function refreshMeasurements() {
    const progress = totalHeight > 0 ? displayOffset / totalHeight : 0;
    postGapPx = currentPostGapPx(viewport);
    heights = measureCrawlItems(items);
    prefix = buildPrefixSums(heights, postGapPx);
    totalHeight = prefix[prefix.length - 1];
    displayOffset = clampOffset(progress * totalHeight);
    renderedStart = -1;
    renderedEnd = -1;
    for (const [index, el] of renderedItems) {
      el.style.top = `${prefix[index]}px`;
    }
    crawl.style.height = `${totalHeight}px`;
    syncScrollState();
    lastMeasuredWidth = window.innerWidth;
    lastMeasuredHeight = viewport.clientHeight;
  }

  function maybeRefreshOnResize() {
    // Width changes affect line balancing; height changes affect the
    // viewport-based post gap. Either way, rebuild the prefix table so
    // every top position keeps the exact same inter-post gap.
    if (window.innerWidth !== lastMeasuredWidth || viewport.clientHeight !== lastMeasuredHeight) {
      refreshMeasurements();
    } else {
      syncScrollState();
    }
  }

  function scrubByWheel(event) {
    if (viewport.classList.contains('hidden')) return;
    event.preventDefault();
    if (viewport.classList.contains('scrub-locked')) return;

    const rawDeltaPx = wheelDeltaToPixels(event, viewport);
    wheelRemainder += rawDeltaPx;

    const direction = Math.sign(wheelRemainder);
    if (!direction) return;

    const pendingSteps = Math.floor(Math.abs(wheelRemainder) / WHEEL_DELTA_STEP_PX);
    if (!pendingSteps) return;

    const steps = Math.min(pendingSteps, WHEEL_MAX_STEPS);
    const jump = viewport.clientHeight * WHEEL_JUMP_VIEWPORTS * steps;
    displayOffset = clampOffset(displayOffset + direction * jump);

    if (pendingSteps > WHEEL_MAX_STEPS) {
      wheelRemainder = 0;
    } else {
      wheelRemainder -= direction * steps * WHEEL_DELTA_STEP_PX;
    }

    syncScrollState();
  }

  function onTouchStart(event) {
    if (viewport.classList.contains('hidden')) return;
    if (viewport.classList.contains('scrub-locked')) return;
    if (activeTouchId !== null) return;
    const t = event.changedTouches[0];
    if (!t) return;
    activeTouchId = t.identifier;
    touchLastY = t.clientY;
    touchLastT = performance.now();
    touchMoved = false;
    touchVelocity = 0;
    flickVelocity = 0;
  }

  function findTouch(list) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === activeTouchId) return list[i];
    }
    return null;
  }

  function onTouchMove(event) {
    if (activeTouchId === null) return;
    const t = findTouch(event.touches);
    if (!t) return;
    // Prevent the browser's own touch pan/zoom while we drive the scrub.
    if (event.cancelable) event.preventDefault();
    const now = performance.now();
    const dy = (touchLastY - t.clientY) * TOUCH_DRAG_GAIN;
    const dt = Math.max((now - touchLastT) / 1000, 0.001);
    if (Math.abs(dy) > 0.5) touchMoved = true;
    displayOffset = clampOffset(displayOffset + dy);
    // Exponential-ish smoothing on velocity so a brief stop before release
    // doesn't get treated as a hard flick.
    const instV = dy / dt;
    touchVelocity = touchVelocity * 0.6 + instV * 0.4;
    touchLastY = t.clientY;
    touchLastT = now;
    syncScrollState();
  }

  function onTouchEnd(event) {
    if (activeTouchId === null) return;
    const t = findTouch(event.changedTouches);
    if (!t) return;
    activeTouchId = null;
    if (touchMoved && Math.abs(touchVelocity) > TOUCH_FLICK_MIN_VELOCITY) {
      flickVelocity = clampNumber(touchVelocity, -TOUCH_FLICK_MAX_PX_S, TOUCH_FLICK_MAX_PX_S);
    } else {
      flickVelocity = 0;
    }
    touchVelocity = 0;
    touchMoved = false;
  }

  function onTouchCancel() {
    activeTouchId = null;
    touchVelocity = 0;
    flickVelocity = 0;
    touchMoved = false;
  }

  crawl.style.height = `${totalHeight}px`;
  syncScrollState();
  window.addEventListener('wheel', scrubByWheel, { passive: false });
  window.addEventListener('resize', maybeRefreshOnResize);
  window.addEventListener('orientationchange', refreshMeasurements);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', maybeRefreshOnResize);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refreshMeasurements).catch(() => {});
  }
  viewport.addEventListener('touchstart', onTouchStart, { passive: true });
  viewport.addEventListener('touchmove', onTouchMove, { passive: false });
  viewport.addEventListener('touchend', onTouchEnd, { passive: true });
  viewport.addEventListener('touchcancel', onTouchCancel, { passive: true });
  window.addEventListener('pointerdown', (event) => {
    // Touch-driven pointer events are the crawl scrub, not text selection.
    if (event.pointerType === 'touch') return;
    isSelectingText = true;
  });
  window.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') return;
    isSelectingText = false;
    renderedStart = -1;
    renderedEnd = -1;
    renderRange();
  });
  window.addEventListener('pointercancel', () => {
    isSelectingText = false;
    renderedStart = -1;
    renderedEnd = -1;
    renderRange();
  });
  window.addEventListener('blur', () => {
    isSelectingText = false;
    activeTouchId = null;
    flickVelocity = 0;
    renderedStart = -1;
    renderedEnd = -1;
    renderRange();
  });

  function tick(now) {
    const dt = Math.min((now - lastT) / 1000, 0.1); // clamp big gaps (tab switch)
    lastT = now;

    let delta = currentCrawlSpeed() * dt;

    if (flickVelocity !== 0) {
      delta += flickVelocity * dt;
      // Exponential decay; once small enough, snap to 0.
      flickVelocity *= Math.exp(-TOUCH_FLICK_DECAY * dt);
      if (Math.abs(flickVelocity) < TOUCH_FLICK_MIN_VELOCITY) flickVelocity = 0;
    }

    displayOffset = clampOffset(displayOffset + delta);
    syncScrollState();
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(t => { lastT = t; tick(t); });
}

/* ---------- Intro ---------- */

function playIntro() {
  return new Promise(resolve => {
    const intro    = document.getElementById('intro');
    const tagline  = document.getElementById('tagline');
    const logo     = document.getElementById('logo');

    tagline.textContent = TAGLINE;

    intro.classList.remove('hidden');
    tagline.classList.add('play');

    setTimeout(() => {
      // Hide tagline (animation already brings opacity to 0 by 5s),
      // then start logo zoom.
      logo.classList.add('play');
      setTimeout(() => {
        intro.classList.add('hidden');
        resolve();
      }, INTRO_LOGO_MS);
    }, INTRO_TAGLINE_MS + INTRO_GAP_MS);
  });
}

/* ---------- Footer ---------- */

function setupFooter() {
  const startYear = 2026;
  const currentYear = new Date().getFullYear();
  // Show a range once we're past the start year; just the start otherwise.
  const yearText = currentYear > startYear
    ? `${startYear}–${currentYear}`
    : `${startYear}`;
  document.querySelectorAll('.year-range').forEach(el => {
    el.textContent = yearText;
  });

  const footer = document.getElementById('site-footer');
  const toggle = document.getElementById('footer-toggle');
  if (!footer || !toggle) return;

  function close() {
    if (!footer.classList.contains('expanded')) return;
    footer.classList.remove('expanded');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const willExpand = !footer.classList.contains('expanded');
    footer.classList.toggle('expanded', willExpand);
    toggle.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
  });
  toggle.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });

  // When the panel is open and the user taps outside it, close the panel
  // and *swallow the subsequent click* — the user almost certainly meant
  // "dismiss" rather than "activate the Episode link I just tapped".
  let closedAt = 0;
  document.addEventListener('pointerdown', (event) => {
    if (!footer.classList.contains('expanded')) return;
    if (footer.contains(event.target)) return;
    close();
    closedAt = performance.now();
  }, true);

  document.addEventListener('click', (event) => {
    if (closedAt && performance.now() - closedAt < 400) {
      event.preventDefault();
      event.stopPropagation();
      closedAt = 0;
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && footer.classList.contains('expanded')) {
      close();
      toggle.focus();
    }
  });
}

/* ---------- Main ---------- */

async function main() {
  setupFooter();
  const loading = document.getElementById('loading');
  const viewport = document.getElementById('crawl-viewport');
  viewport.classList.add('scrub-locked');

  let posts;
  try {
    posts = await fetchAndPrepare();
  } catch (err) {
    loading.textContent = 'TRANSMISSION FAILED';
    console.error(err);
    return;
  }

  loading.classList.add('hidden');

  if (!posts.length) {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('loading').textContent = 'NO TRANSMISSIONS FOUND';
    return;
  }

  await waitForFonts();

  const introDone = playIntro();
  const crawlDelay = INTRO_TAGLINE_MS + INTRO_GAP_MS + Math.max(0, INTRO_LOGO_MS - currentCrawlLogoOverlapMs());
  let crawlStarted = false;

  function launchCrawl() {
    if (crawlStarted) return;
    crawlStarted = true;
    viewport.classList.remove('hidden');
    startCrawl(posts);
  }

  setTimeout(launchCrawl, crawlDelay);
  await introDone;
  viewport.classList.remove('scrub-locked');
  launchCrawl();
}

main();
