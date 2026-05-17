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
const MIN_TEXT_CHARS   = 1;
const MAX_IMAGES       = 4;
const FETCH_TIMEOUT_MS = 12000;
const EMBED_REMOTE_IMAGES = false;

const INTRO_TAGLINE_MS = 5000;
const INTRO_LOGO_MS    = 6000;
const INTRO_GAP_MS     = 300;
const CRAWL_LOGO_OVERLAP_MS = 5000;

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

  const episode = document.createElement('p');
  episode.className = 'episode';
  episode.textContent = `EPISODE ${post.episode}`;
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
  const crawlWidth = Math.min(
    window.innerWidth * (window.innerWidth <= 640 ? 0.92 : 0.86),
    920
  );
  const approxCharWidth = window.innerWidth <= 640 ? 13 : 18;
  return clampNumber(Math.floor(crawlWidth / approxCharWidth), 22, 52);
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

  crawl.style.height = `${totalHeight}px`;
  syncScrollState();
  window.addEventListener('wheel', scrubByWheel, { passive: false });
  window.addEventListener('resize', refreshMeasurements);
  window.addEventListener('pointerdown', () => {
    isSelectingText = true;
  });
  window.addEventListener('pointerup', () => {
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
    renderedStart = -1;
    renderedEnd = -1;
    renderRange();
  });

  function tick(now) {
    const dt = Math.min((now - lastT) / 1000, 0.1); // clamp big gaps (tab switch)
    lastT = now;
    displayOffset = clampOffset(displayOffset + SPEED_PX_PER_SEC * dt);
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

/* ---------- Main ---------- */

async function main() {
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
