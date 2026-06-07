# Dynamic Content Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover carousel/slider and FAQ/accordion content that a single DOM snapshot misses, so scrapes of SPA sites (e.g. stampsify.pl) include every slide and FAQ answer.

**Architecture:** A new best-effort module `src/dynamic-reveal.ts` exposes `revealDynamicContent(page)`, called just before `page.content()` at all three scrape sites. It (1) force-reveals in-DOM-but-hidden content via `!important` style overrides + attribute/class stripping, then (2) for rotating carousels, polls the DOM for ~3s and, if slides remain uncaptured, advances the carousel's own "next" control, finally injecting all recovered slides as visible static nodes. Pure logic (text hashing, dedup, nav-exclusion, indicator counting) is exported and unit-tested with Node 22's built-in `node --test`; DOM behaviour is integration-verified against the live container.

**Tech Stack:** Node 22, TypeScript (ESM, NodeNext), Playwright Ghost, Fastify; tests via `node --import tsx --test` (tsx already a devDependency). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-07-dynamic-content-reveal-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/dynamic-reveal.ts` | All reveal logic: pure helpers + in-page script builders + orchestrator | Create |
| `tests/dynamic-reveal.test.ts` | Unit tests for the pure helpers | Create |
| `package.json` | Add `test` script | Modify |
| `src/scraper.ts` | Call `revealDynamicContent` before `removeHiddenElements` | Modify (~line 68) |
| `src/site-crawler.ts` | Call `revealDynamicContent` in `scrapePageInContext` and the inline homepage scrape | Modify (~line 396, ~line 489) |
| `Makefile` | Add `test-reveal` target | Modify |
| `CLAUDE.md`, `AGENTS.md` | Document the new module + fix stale source/endpoint/response references | Modify |

---

## Task 1: Pure helpers (TDD)

**Files:**
- Create: `src/dynamic-reveal.ts`
- Test: `tests/dynamic-reveal.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the `test` script to `package.json`**

Change the `scripts` block to:

```json
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "npx tsx src/server.ts",
    "test": "node --import tsx --test tests/dynamic-reveal.test.ts"
  },
```

- [ ] **Step 2: Write the failing unit tests**

Create `tests/dynamic-reveal.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  hashText,
  mergeSlides,
  isNavLike,
  pickSlideCount,
  type CapturedSlide,
} from "../src/dynamic-reveal.js";

test("normalizeText collapses whitespace, trims, lowercases", () => {
  assert.equal(normalizeText("  Hello\n  World "), "hello world");
  assert.equal(normalizeText("A\t\tB"), "a b");
});

test("hashText is whitespace/case-insensitive and stable", () => {
  assert.equal(hashText("Proste  wydawanie"), hashText("proste wydawanie"));
  assert.equal(hashText(""), "");
  assert.equal(hashText("   "), "");
  assert.notEqual(hashText("slide one"), hashText("slide two"));
});

test("mergeSlides adds unique slides, dedups by normalized text, skips empty", () => {
  const collected = new Map<string, CapturedSlide>();
  const added1 = mergeSlides(collected, [
    { html: "<div>A</div>", text: "Slide A" },
    { html: "<div>A2</div>", text: "slide a" }, // dup of "Slide A"
    { html: "<div></div>", text: "   " }, // empty -> skipped
  ]);
  assert.equal(added1, 1);
  assert.equal(collected.size, 1);

  const added2 = mergeSlides(collected, [{ html: "<div>B</div>", text: "Slide B" }]);
  assert.equal(added2, 1);
  assert.equal(collected.size, 2);
});

test("isNavLike flags navigation/menu chrome only", () => {
  assert.equal(isNavLike("main-nav header__inner"), true);
  assert.equal(isNavLike("dropdown-menu show"), true);
  assert.equal(isNavLike("offcanvas-body"), true);
  assert.equal(isNavLike("hero-section how-it-works"), false);
  assert.equal(isNavLike("carousel-item active"), false);
});

test("pickSlideCount returns max candidate >= 2, else 0", () => {
  assert.equal(pickSlideCount([1, 4, 2]), 4);
  assert.equal(pickSlideCount([3]), 3);
  assert.equal(pickSlideCount([1, 1]), 0);
  assert.equal(pickSlideCount([]), 0);
  assert.equal(pickSlideCount([0, 1]), 0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/dynamic-reveal.js'` (module not created yet).

- [ ] **Step 4: Implement the pure helpers**

Create `src/dynamic-reveal.ts` with exactly this content (script builders + orchestrator are added in Task 2):

```ts
import type { Page } from "playwright-ghost";

// ============ PURE HELPERS (unit-tested) ============

export interface CapturedSlide {
  html: string;
  text: string;
}

/** Collapse all whitespace to single spaces, trim, lowercase. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable djb2 hash (base36) of normalized text. Empty/blank input -> "". */
export function hashText(s: string): string {
  const norm = normalizeText(s);
  if (!norm) return "";
  let h = 5381;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 33 + norm.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Merge captured slides into an ordered map keyed by content hash.
 * Skips blank-text and already-seen slides. Returns number newly added.
 */
export function mergeSlides(
  collected: Map<string, CapturedSlide>,
  slides: CapturedSlide[]
): number {
  let added = 0;
  for (const slide of slides) {
    const key = hashText(slide.text);
    if (!key) continue;
    if (collected.has(key)) continue;
    collected.set(key, slide);
    added++;
  }
  return added;
}

/** True if a className+id string looks like navigation/menu chrome. */
export function isNavLike(classAndId: string): boolean {
  const s = classAndId.toLowerCase();
  return ["nav", "menu", "dropdown", "offcanvas", "drawer"].some((t) =>
    s.includes(t)
  );
}

/** Pick the most plausible slide count from candidate counts. 0 if none >= 2. */
export function pickSlideCount(counts: number[]): number {
  const valid = counts.filter((c) => Number.isFinite(c) && c >= 2);
  return valid.length ? Math.max(...valid) : 0;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/dynamic-reveal.ts tests/dynamic-reveal.test.ts package.json
git commit -m "feat(reveal): pure helpers for dynamic content reveal + unit tests"
```

---

## Task 2: In-page script builders + orchestrator

DOM glue cannot be unit-tested here (no jsdom in the repo); it is integration-verified in Task 5. This task appends the script builders and the orchestrator to `src/dynamic-reveal.ts`. All code is complete — no placeholders.

**Files:**
- Modify: `src/dynamic-reveal.ts`

- [ ] **Step 1: Append selector constants and in-page reveal helper sources**

Append to `src/dynamic-reveal.ts`:

```ts
// ============ IN-PAGE SELECTORS ============

const SLIDER_CONTAINERS = [
  ".swiper",
  ".slick-slider",
  ".splide",
  ".embla",
  ".carousel",
  "[data-carousel]",
  '[aria-roledescription="carousel"]',
  "ngb-carousel",
];

const SLIDE_ITEMS = [
  ".swiper-slide:not(.swiper-slide-duplicate)",
  ".slick-slide:not(.slick-cloned)",
  ".splide__slide:not(.splide__slide--clone)",
  ".embla__slide",
  ".carousel-item",
];

const FAQ_PANELS = [
  "[class*='accordion']",
  "[class*='faq']",
  ".collapse",
  "[class*='collapse']",
  "[role='region'][aria-labelledby]",
];

const INDICATORS = [
  ".carousel-indicators > *",
  "[aria-label^='Slide']",
  ".swiper-pagination-bullet",
  "ngb-slide",
];

const NEXT_CONTROLS = [
  ".carousel-control-next",
  ".swiper-button-next",
  ".slick-next",
  ".splide__arrow--next",
  ".embla__button--next",
  "[aria-label*='Next' i]",
  "[aria-label*='next' i]",
];

/** Pure helper sources injected into the page (named function declarations). */
const INJECTED = [isNavLike, pickSlideCount].map((f) => f.toString()).join("\n");
```

- [ ] **Step 2: Append the result types and the force-reveal/detect script builder**

Append to `src/dynamic-reveal.ts`:

```ts
// ============ IN-PAGE SCRIPT BUILDERS ============

interface DetectedCarousel {
  cid: number;
  n: number;
  slidesInDom: number;
}

interface DetectResult {
  containers: DetectedCarousel[];
  faqsExpanded: number;
  revealed: number;
}

/**
 * Builds the always-run pass: force-reveals FAQ + static slider content and
 * tags rotating carousels with data-reveal-cid for later capture/injection.
 */
function buildRevealScript(): string {
  return `(() => {
    ${INJECTED}
    const SLIDER_CONTAINERS = ${JSON.stringify(SLIDER_CONTAINERS)};
    const SLIDE_ITEMS = ${JSON.stringify(SLIDE_ITEMS)};
    const FAQ_PANELS = ${JSON.stringify(FAQ_PANELS)};
    const INDICATORS = ${JSON.stringify(INDICATORS)};
    const containerSel = SLIDER_CONTAINERS.join(',');
    const slideSel = SLIDE_ITEMS.join(',');
    const MAX_REVEAL = 200;

    function classId(el) {
      const cls = el.className && el.className.baseVal !== undefined
        ? el.className.baseVal : String(el.className || '');
      return cls + ' ' + (el.id || '');
    }
    function inNav(el) {
      let n = el;
      while (n && n !== document.body) {
        if (n.tagName === 'NAV' || n.tagName === 'HEADER') return true;
        if (n.getAttribute && n.getAttribute('role') === 'navigation') return true;
        if (isNavLike(classId(n))) return true;
        n = n.parentElement;
      }
      return false;
    }
    function reveal(el) {
      el.removeAttribute('hidden');
      el.removeAttribute('aria-hidden');
      el.classList.remove('hidden', 'visually-hidden');
      const p = (k, v) => el.style.setProperty(k, v, 'important');
      p('display', 'block'); p('visibility', 'visible'); p('opacity', '1');
      p('max-height', 'none'); p('height', 'auto'); p('overflow', 'visible');
      p('transform', 'none'); p('position', 'static');
    }

    let revealed = 0, faqs = 0;

    // FAQ: native <details>
    document.querySelectorAll('details').forEach((d) => {
      if (revealed >= MAX_REVEAL) return;
      if (inNav(d)) return;
      if (!d.open) { d.open = true; faqs++; revealed++; }
    });

    // FAQ: accordion/collapse panels
    FAQ_PANELS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (revealed >= MAX_REVEAL) return;
        if (inNav(el)) return;
        reveal(el);
        faqs++; revealed++;
      });
    });

    // Sliders: reveal slide items inside recognized containers
    document.querySelectorAll(slideSel).forEach((s) => {
      if (revealed >= MAX_REVEAL) return;
      if (inNav(s)) return;
      if (!s.closest(containerSel)) return;
      reveal(s);
      revealed++;
    });

    // Detect rotating carousels (more slides claimed than present) and tag them
    const out = [];
    let cid = 0;
    document.querySelectorAll(containerSel).forEach((c) => {
      if (inNav(c)) return;
      const slidesInDom = c.querySelectorAll(slideSel).length;
      const counts = [];
      INDICATORS.forEach((sel) => { counts.push(c.querySelectorAll(sel).length); });
      const n = pickSlideCount(counts);
      if (n > slidesInDom && slidesInDom >= 1) {
        c.setAttribute('data-reveal-cid', String(cid));
        out.push({ cid: cid, n: n, slidesInDom: slidesInDom });
        cid++;
      }
    });

    return { containers: out, faqsExpanded: faqs, revealed: revealed };
  })()`;
}
```

- [ ] **Step 3: Append the capture and inject script builders**

Append to `src/dynamic-reveal.ts`:

```ts
/** Builds a script that returns the slides currently present in a tagged container. */
function buildCaptureScript(cid: number): string {
  return `(() => {
    const SLIDE_ITEMS = ${JSON.stringify(SLIDE_ITEMS)};
    const c = document.querySelector('[data-reveal-cid="${cid}"]');
    if (!c) return [];
    const slides = c.querySelectorAll(SLIDE_ITEMS.join(','));
    return Array.from(slides).map((s) => ({
      html: s.outerHTML,
      text: (s.textContent || '').trim(),
    }));
  })()`;
}

/** Builds a script that appends recovered slides as visible static nodes. */
function buildInjectScript(cid: number, htmls: string[]): string {
  return `((htmls) => {
    const c = document.querySelector('[data-reveal-cid="${cid}"]');
    if (!c) return 0;
    let n = 0;
    for (const html of htmls) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const node = tpl.content.firstElementChild;
      if (!node) continue;
      node.setAttribute('data-recovered-slide', '1');
      const p = (k, v) => node.style.setProperty(k, v, 'important');
      p('display', 'block'); p('visibility', 'visible'); p('opacity', '1');
      p('position', 'static'); p('transform', 'none');
      p('height', 'auto'); p('max-height', 'none');
      c.appendChild(node);
      n++;
    }
    return n;
  })(${JSON.stringify(htmls)})`;
}
```

- [ ] **Step 4: Append the orchestrator**

Append to `src/dynamic-reveal.ts`:

```ts
// ============ ORCHESTRATOR ============

export interface RevealOptions {
  accumulateMs?: number;
  pollIntervalMs?: number;
}

export interface RevealMetrics {
  carouselsFound: number;
  slidesRecovered: number;
  faqsExpanded: number;
}

/**
 * Best-effort: reveals carousel/FAQ content hidden from a single DOM snapshot.
 * Never throws — a failure here must not fail an otherwise-successful scrape.
 * Call immediately before page.content().
 */
export async function revealDynamicContent(
  page: Page,
  opts: RevealOptions = {}
): Promise<RevealMetrics> {
  const accumulateMs = opts.accumulateMs ?? 3000;
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const metrics: RevealMetrics = {
    carouselsFound: 0,
    slidesRecovered: 0,
    faqsExpanded: 0,
  };

  try {
    const detect = (await page.evaluate(buildRevealScript())) as DetectResult;
    metrics.faqsExpanded = detect.faqsExpanded;
    metrics.carouselsFound = detect.containers.length;

    for (const container of detect.containers) {
      const collected = new Map<string, CapturedSlide>();

      // Seed with slides already present
      const initial = (await page.evaluate(
        buildCaptureScript(container.cid)
      )) as CapturedSlide[];
      mergeSlides(collected, initial);

      // Passive polling (early-exit when we've collected the claimed count)
      const polls = Math.max(1, Math.floor(accumulateMs / pollIntervalMs));
      for (let i = 0; i < polls && collected.size < container.n; i++) {
        await page.waitForTimeout(pollIntervalMs);
        const slides = (await page.evaluate(
          buildCaptureScript(container.cid)
        )) as CapturedSlide[];
        mergeSlides(collected, slides);
      }

      // Bounded next-fallback: advance the carousel's own control if slides remain
      if (collected.size < container.n) {
        const maxClicks = Math.max(container.n, 10);
        const nextSel = NEXT_CONTROLS.map(
          (s) => `[data-reveal-cid="${container.cid}"] ${s}`
        ).join(",");
        const nextBtn = page.locator(nextSel).first();
        let noNew = 0;
        for (
          let c = 0;
          c < maxClicks && collected.size < container.n && noNew < 2;
          c++
        ) {
          try {
            if (!(await nextBtn.isVisible({ timeout: 300 }))) break;
            await nextBtn.click({ timeout: 800 });
          } catch {
            break;
          }
          await page.waitForTimeout(600);
          const slides = (await page.evaluate(
            buildCaptureScript(container.cid)
          )) as CapturedSlide[];
          const added = mergeSlides(collected, slides);
          noNew = added > 0 ? 0 : noNew + 1;
        }
      }

      // Inject collected slides that are not currently present
      const present = (await page.evaluate(
        buildCaptureScript(container.cid)
      )) as CapturedSlide[];
      const presentKeys = new Set(present.map((s) => hashText(s.text)));
      const toInject = [...collected.values()].filter(
        (s) => !presentKeys.has(hashText(s.text))
      );
      if (toInject.length) {
        const injected = (await page.evaluate(
          buildInjectScript(
            container.cid,
            toInject.map((s) => s.html)
          )
        )) as number;
        metrics.slidesRecovered += injected;
      }
    }
  } catch {
    // best-effort — swallow and return whatever metrics we have
  }

  return metrics;
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run build`
Expected: PASS — no TypeScript errors. (`dist/dynamic-reveal.js` is produced.)

- [ ] **Step 6: Verify unit tests still pass (no regression in helpers)**

Run: `npm test`
Expected: PASS — all 5 tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/dynamic-reveal.ts
git commit -m "feat(reveal): in-page reveal/capture/inject scripts + orchestrator"
```

---

## Task 3: Wire into the single-page scraper

**Files:**
- Modify: `src/scraper.ts`

- [ ] **Step 1: Import the module**

In `src/scraper.ts`, add to the imports block (after the existing `./ssrf-guard.js` import on line 4):

```ts
import { revealDynamicContent } from "./dynamic-reveal.js";
```

- [ ] **Step 2: Call reveal before removeHiddenElements**

In `src/scraper.ts`, the current code around line 64-72 reads:

```ts
    // Scroll to bottom to trigger lazy-loaded content
    await scrollToBottom(page);

    // Small delay to let any final content render
    await page.waitForTimeout(500);

    // Remove elements that are visually hidden (computed styles)
```

Insert the reveal call between the `waitForTimeout(500)` and the `removeHiddenElements` comment. `scraper.ts` has no Fastify logger in scope, so log metrics with `console.log`. The block becomes:

```ts
    // Scroll to bottom to trigger lazy-loaded content
    await scrollToBottom(page);

    // Small delay to let any final content render
    await page.waitForTimeout(500);

    // Reveal carousel/slider + FAQ content hidden from a single snapshot.
    // Must run BEFORE removeHiddenElements so recovered content survives.
    const revealMetrics = await revealDynamicContent(page);
    if (revealMetrics.slidesRecovered > 0 || revealMetrics.faqsExpanded > 0) {
      console.log("dynamic-reveal", JSON.stringify(revealMetrics));
    }

    // Remove elements that are visually hidden (computed styles)
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/scraper.ts
git commit -m "feat(reveal): wire revealDynamicContent into single-page scraper"
```

---

## Task 4: Wire into the site crawler (both scrape sites)

**Files:**
- Modify: `src/site-crawler.ts`

- [ ] **Step 1: Import the module**

In `src/site-crawler.ts`, add after the existing `./nav-extractor.js` import (line 12):

```ts
import { revealDynamicContent } from "./dynamic-reveal.js";
```

- [ ] **Step 2: Call reveal in `scrapePageInContext`**

In `src/site-crawler.ts`, `scrapePageInContext` currently reads:

```ts
    await page.waitForTimeout(2000);
    await scrollToBottom(page);
    await page.waitForTimeout(500);

    const rawHtml = await page.content();
```

Change it to:

```ts
    await page.waitForTimeout(2000);
    await scrollToBottom(page);
    await page.waitForTimeout(500);
    await revealDynamicContent(page);

    const rawHtml = await page.content();
```

- [ ] **Step 3: Call reveal in the inline homepage scrape**

In `src/site-crawler.ts`, the homepage scrape currently reads:

```ts
    await homePage.waitForTimeout(2000);
    await scrollToBottom(homePage);
    await homePage.waitForTimeout(500);

    const homepageHtml = await homePage.content();
```

Change it to:

```ts
    await homePage.waitForTimeout(2000);
    await scrollToBottom(homePage);
    await homePage.waitForTimeout(500);
    await revealDynamicContent(homePage);

    const homepageHtml = await homePage.content();
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/site-crawler.ts
git commit -m "feat(reveal): wire revealDynamicContent into site crawler (both scrape sites)"
```

---

## Task 5: Integration validation against the live container

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Add a `test-reveal` Make target**

In `Makefile`, after the `scrape-site` target (ends at line 54), add:

```makefile
test-reveal: ## Reveal check: make test-reveal URL=https://example.com
	@test -n "$(URL)" || (echo "Usage: make test-reveal URL=https://example.com" && exit 1)
	@curl -s -X POST $(SCRAPER_URL)/scrape \
		-H 'Content-Type: application/json' \
		-d '{"url": "$(URL)", "timeout": 30000}' | jq -r '.markdown'
```

Also add `test-reveal` to the `.PHONY` line (line 9):

```makefile
.PHONY: help rebuild up logs wait scrape scrape-site test-reveal
```

- [ ] **Step 2: Rebuild the image and restart the container**

The compose file fails config validation when `MODEL_DIR` is unset, so build/run the scraper image directly (this is how it was started earlier in the session):

Run:
```bash
docker build -t on-prem-workhorse:latest . && \
docker rm -f scraper 2>/dev/null; \
docker run -d --name scraper -p 3000:3000 -e UV_THREADPOOL_SIZE=16 on-prem-workhorse:latest && \
for i in $(seq 1 30); do curl -sf http://localhost:3000/health >/dev/null 2>&1 && { echo "ready"; break; }; sleep 1; done
```
Expected: `ready` printed; `curl -s http://localhost:3000/health` returns `{"status":"ok",...}`.

- [ ] **Step 3: Acceptance — stampsify.pl recovers all carousel slides**

Run:
```bash
curl -s -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://stampsify.pl/","timeout":30000}' \
  | jq -r '.markdown' > /tmp/stampsify-after.md
grep -c "Proste wydawanie wirtualnych pieczątek" /tmp/stampsify-after.md
grep -c "Elastyczne konta pracownicze" /tmp/stampsify-after.md
```
Expected: first grep ≥ 1 (previously-missing slide now present), second grep ≥ 1 (already-present slide still there).

If the first grep is `0`, inspect container logs for the `dynamic-reveal` line and the recovered-slide count:
```bash
docker logs scraper 2>&1 | grep dynamic-reveal | tail -5
```

- [ ] **Step 4: Regression — a no-carousel page is unaffected and not slowed**

Run:
```bash
time curl -s -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/","timeout":30000}' \
  | jq -r '.markdown' | head -5
```
Expected: normal markdown for example.com; total time comparable to before (no multi-second carousel delay, since no carousel is detected).

- [ ] **Step 5: Regression — mobile menu is not force-revealed**

Pick any site from the existing `make test-*` list that has a nav menu (e.g. `https://www.tembo.io`). Run:
```bash
curl -s -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.tembo.io","timeout":30000}' \
  | jq -r '.markdown' | wc -l
```
Expected: markdown is coherent (not flooded with duplicated nav-link lists). Compare against expectation that navigation menus are skipped; if the output is dominated by repeated menu entries, the nav-exclusion predicate needs widening (revisit `isNavLike` tokens / `inNav` ancestor checks).

- [ ] **Step 6: Commit**

```bash
git add Makefile
git commit -m "test(reveal): add make test-reveal target + validate on stampsify"
```

---

## Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1: Add the new module to the Source Files list**

`CLAUDE.md` and `AGENTS.md` are byte-identical. In both, in the `## Source Files` tree, add the new module and the two already-missing files so the list matches `src/`:

```
src/
├── server.ts          # Fastify REST API, endpoints, validation
├── scraper.ts         # Single-page scraper (navigate, scroll, extract)
├── site-crawler.ts    # Multi-page orchestrator (discover, score, batch scrape)
├── html-parser.ts     # HTML → Markdown (preprocessing, turndown, postprocessing)
├── sitemap-parser.ts  # /sitemap.xml fetcher & parser
├── nav-extractor.ts   # Navigation link extraction from HTML
├── stealth.ts         # Playwright Ghost browser setup (anti-detection)
├── ssrf-guard.ts      # SSRF protection (private-IP / scheme blocking)
├── favicon.ts         # Favicon discovery & base64 fetch
└── dynamic-reveal.ts  # Reveal carousel/slider + FAQ content before snapshot
```

- [ ] **Step 2: Document the reveal step in the architecture section**

In both files, in `### Single page (/scrape)`, update the pipeline line to mention reveal, e.g. change:

```
→ scroll to bottom (lazy load) → extract HTML →
```
to:
```
→ scroll to bottom (lazy load) → reveal carousels/FAQ (dynamic-reveal.ts) → extract HTML →
```

Add a short subsection after `### Stealth browser (stealth.ts)`:

```
### Dynamic content reveal (dynamic-reveal.ts)
Recovers content a single DOM snapshot misses. Always force-reveals in-DOM-but-hidden
slider/FAQ content via !important overrides + attribute/class stripping. For rotating
carousels (e.g. ng-bootstrap, which renders only the active slide), polls ~3s then, if
slides remain, advances the carousel's own "next" control, injecting recovered slides as
static nodes. Best-effort: never fails a scrape. Runs before removeHiddenElements.
```

- [ ] **Step 3: Note the `/favicon` endpoint and real `/scrape` response fields**

In both files, in the API Endpoints table, add the row:

```
| `/favicon` | POST | Fetch favicon as base64 data URI |
```

Under the `### Response format` for `/scrape`, add:

```
`/scrape` returns: `source`, `markdown`, `cleanedHtml`, `rawHtml`, `favicon`,
`heroScreenshot`, `contentHash`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: document dynamic-reveal module + fix stale source/endpoint references"
```

---

## Final verification

- [ ] `npm test` passes (unit helpers).
- [ ] `npm run build` passes (full TypeScript build).
- [ ] `make test-reveal URL=https://stampsify.pl/ | grep "Proste wydawanie"` returns the line (acceptance).
- [ ] No-carousel page (example.com) shows no added latency.
- [ ] Nav-heavy page shows no menu flooding.
