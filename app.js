/* ============================================================
   Culture Wars — Trump Truth Social Star Wars crawl
   ============================================================ */

const ARCHIVE_URL = 'https://ix.cnn.io/data/truth-social/truth_archive.json';

const SPEED_PX_PER_SEC = 55;
const RENDER_BEHIND_VIEWPORTS = 4;
const RENDER_AHEAD_VIEWPORTS = 7;
const WHEEL_DELTA_STEP_PX = 110;
const WHEEL_MAX_STEPS = 3;
const WHEEL_JUMP_VIEWPORTS = 0.07;
const TOUCH_DRAG_GAIN = 1.4;       // finger-pixel → crawl-pixel multiplier
const TOUCH_FLICK_MAX_PX_S = 4200; // cap on flick momentum velocity
const TOUCH_FLICK_DECAY = 4.5;     // momentum decay rate per second
const TOUCH_FLICK_MIN_VELOCITY = 40;
const MIN_TEXT_CHARS   = 1;
const MAX_IMAGES       = 4;
const FETCH_TIMEOUT_MS = 12000;
const EMBED_REMOTE_IMAGES = false;

const INTRO_TAGLINE_MS = 5000;
const INTRO_LOGO_MS    = 7500;
const INTRO_GAP_MS     = 300;
// The crawl element appears partway through the logo recession so the
// text has time to actually travel into the viewport from below. The
// 12vh starting offset (see CSS) plus the constant 55 px/s climb means
// the first line takes ~1–2 s to clear the screen edge depending on
// viewport height; we need that lead time to baked into the overlap.
const CRAWL_LOGO_OVERLAP_MS = 3500;

const TAGLINE = 'Not a long time ago, in a galaxy not far, far away...';

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)(\?|$|#)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)(\?|$|#)/i;

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

function cleanSentenceBreaks(sentences) {
  const out = [];
  for (const sentence of sentences) {
    const previous = out[out.length - 1];
    if (previous && /\bJ\.$/.test(previous) && /^TRUMP\b/.test(sentence)) {
      out[out.length - 1] = `${previous} ${sentence}`;
    } else {
      out.push(sentence);
    }
  }
  return out;
}

function splitSentences(text) {
  if (!text) return [];

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return cleanSentenceBreaks(
      Array.from(segmenter.segment(text), part => part.segment.trim()).filter(Boolean)
    );
  }

  const protectedText = text
    .replace(/\bU\.S\.A\./g, 'U<dot>S<dot>A<dot>')
    .replace(/\bU\.S\./g, 'U<dot>S<dot>')
    .replace(/\bD\.C\./g, 'D<dot>C<dot>')
    .replace(/\bJ\. TRUMP\b/g, 'J<dot> TRUMP');

  return cleanSentenceBreaks(
    (protectedText.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [])
      .map(sentence => sentence.replaceAll('<dot>', '.').trim())
      .filter(Boolean)
  );
}

function classifyMedia(url) {
  if (typeof url !== 'string') return 'other';
  if (VIDEO_EXT_RE.test(url)) return 'video';
  if (IMAGE_EXT_RE.test(url)) return 'image';
  return 'other';
}

function canEmbedImage(url) {
  if (EMBED_REMOTE_IMAGES) return true;

  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin || u.protocol === 'data:' || u.protocol === 'blob:';
  } catch {
    return false;
  }
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

    const images = media.filter(u => classifyMedia(u) === 'image' && canEmbedImage(u));

    out.push({
      id: r.id,
      url: typeof r.url === 'string' && r.url ? r.url : '',
      dateLine: formatDateLine(r.created_at),
      body: text,
      sentences: splitSentences(text),
      images: images.slice(0, MAX_IMAGES)
    });
  }

  // Source is already newest-first; assign episode I = newest qualifying.
  out.forEach((p, idx) => { p.episode = toRoman(idx + 1); });
  return out;
}

/* ---------- Rendering ---------- */

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
    for (const line of balanceSentenceLines(sentence)) {
      const span = document.createElement('span');
      span.className = 'line';
      span.textContent = line;
      p.appendChild(span);
    }
    body.appendChild(p);
  }
  section.appendChild(body);

  if (post.images.length) {
    const grid = document.createElement('div');
    grid.className = `media-grid n${Math.min(post.images.length, MAX_IMAGES)}`;
    for (const url of post.images) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        img.remove();
        const count = grid.querySelectorAll('img').length;
        if (count === 0) {
          grid.remove();
        } else {
          grid.className = `media-grid n${Math.min(count, MAX_IMAGES)}`;
        }
      });
      grid.appendChild(img);
    }
    section.appendChild(grid);
  }

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

function buildPrefixSums(heights) {
  const prefix = [0];
  for (const height of heights) {
    prefix.push(prefix[prefix.length - 1] + height);
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
    const style = getComputedStyle(el);
    const height = el.offsetHeight + parseFloat(style.marginBottom || '0');
    el.remove();
    return height;
  });

  probe.remove();
  return heights;
}

async function waitForFonts() {
  if (!document.fonts || !document.fonts.ready) return;

  await Promise.race([
    document.fonts.ready,
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
}

/* ---------- Crawl engine: windowed rAF ---------- */

function startCrawl(posts) {
  const crawl = document.getElementById('crawl');
  const viewport = document.getElementById('crawl-viewport');
  const items = posts.map(post => ({ type: 'post', post })).concat({ type: 'end' });

  let heights = measureCrawlItems(items);
  let prefix = buildPrefixSums(heights);
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
    heights = measureCrawlItems(items);
    prefix = buildPrefixSums(heights);
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
  }

  function maybeRefreshOnResize() {
    // The visual viewport on iOS fires resize for browser-chrome growth/shrink
    // — we don't want to re-measure (and re-line-balance) for that, only for
    // real width changes / orientation flips.
    if (Math.abs(window.innerWidth - lastMeasuredWidth) > 4) {
      refreshMeasurements();
    } else {
      syncScrollState();
    }
  }

  function scrubByWheel(event) {
    if (viewport.classList.contains('hidden')) return;
    event.preventDefault();

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

    let delta = SPEED_PX_PER_SEC * dt;

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

  // Outside-click / tap closes the panel.
  document.addEventListener('pointerdown', (event) => {
    if (!footer.classList.contains('expanded')) return;
    if (footer.contains(event.target)) return;
    close();
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
  const crawlDelay = INTRO_TAGLINE_MS + INTRO_GAP_MS + Math.max(0, INTRO_LOGO_MS - CRAWL_LOGO_OVERLAP_MS);
  let crawlStarted = false;

  function launchCrawl() {
    if (crawlStarted) return;
    crawlStarted = true;
    viewport.classList.remove('hidden');
    startCrawl(posts);
  }

  setTimeout(launchCrawl, crawlDelay);
  await introDone;
  launchCrawl();
}

main();
