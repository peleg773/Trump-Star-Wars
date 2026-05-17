# Culture Wars

Live at [https://peleg773.github.io/Trump-Star-Wars/](https://peleg773.github.io/Trump-Star-Wars/).

A single-page web toy that takes Donald Trump's Truth Social posts and serves them up as a *Star Wars* opening crawl — yellow text receding into space, starfield in the background, the works.

It pulls from CNN's public Truth Social archive, filters out anything that wouldn't read well as a crawl (retweets, link dumps, video posts), numbers each remaining post as an "episode" in Roman numerals, and scrolls them up into the void.

## Running it

There's no build step. Because the app fetches a remote JSON archive and uses `DOMParser` / `Intl.Segmenter`, you'll want to serve it over HTTP rather than opening `index.html` directly:

```
python -m http.server
```

Then open `http://localhost:8000` in a browser. Any static file server works.

## How it behaves

1. **Loading** — a pulsing "LOADING TRANSMISSIONS…" placeholder while the archive is fetched from `ix.cnn.io/data/truth-social/truth_archive.json`.
2. **Intro** — the tagline ("Not a long time ago, in a galaxy not far, far away…") fades in and out, then the *Culture Wars* logo zooms away into the distance.
3. **Crawl** — posts slide up the screen, tilted into perspective, each labeled with its episode number and timestamp. Scrolling the mouse wheel scrubs forward or backward; the animation never stops on its own.
4. **End card** — once all posts have scrolled past, a "TRANSMISSION ENDS" card closes things out.

## Files

- [index.html](index.html) — page scaffold: starfield div, loading indicator, intro container, crawl viewport.
- [style.css](style.css) — starfield (rendered with two `box-shadow`-heavy pseudo-elements), intro animations, and the perspective-tilted crawl. The crawl viewport uses a CSS mask to fade text into black as it recedes.
- [app.js](app.js) — fetches the archive, cleans and segments each post, measures everything off-screen, then runs a windowed `requestAnimationFrame` loop that only keeps a handful of posts in the DOM at any given time.
- [logo.png](logo.png) — the *Culture Wars* title card used in the intro.

## A few implementation notes

**Filtering.** The archive includes a lot that doesn't belong in a movie crawl. [app.js](app.js) drops anything with an attached video, anything that looks like a retweet (`RT ...`), and anything containing a link or bare URL. The rendered crawl is text-only; attached images and other non-text media are ignored.

**Sentence splitting.** Posts are broken into sentences so each one can be laid out as its own paragraph. `Intl.Segmenter` does the heavy lifting where available, with a regex fallback that protects abbreviations like `U.S.`, `D.C.`, and `J. TRUMP` from being split mid-name.

**Line balancing.** Each sentence is then split into screen lines using a small greedy balancer in `balanceSentenceLines` — it tries to make every line of a paragraph roughly the same length, which is what gives the crawl its tidy, centered shape instead of a ragged right edge.

**Windowed rendering.** The archive can be large, so the crawl doesn't put every post in the DOM. It measures every item's height once (in a hidden probe element), builds a prefix-sum table, and only renders items inside a window of roughly 10 viewports behind and 7 ahead of the current scroll offset. Items outside that window are removed, unless the user is currently selecting text — in which case the selection is preserved.

**Tuning.** Most of the dials live at the top of [app.js](app.js): `SPEED_PX_PER_SEC` for crawl speed, `WHEEL_JUMP_VIEWPORTS` for how far each desktop wheel/trackpad scrub step moves, the other `WHEEL_*` values for scrub sensitivity/caps, and the `INTRO_*` timings for the opening sequence.

## Caveats

- The archive URL is a third-party endpoint; if CNN moves or removes it, the page will show "TRANSMISSION FAILED". Point `ARCHIVE_URL` at a local copy to keep it working offline.
