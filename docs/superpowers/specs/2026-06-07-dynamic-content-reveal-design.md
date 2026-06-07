# Dynamic Content Reveal — carousels/sliders + FAQ

**Date:** 2026-06-07
**Status:** Approved design, ready for implementation plan
**Component:** scraper microservice (`on-prem-workhorse`)

## Problem

The scraper captures a **single DOM snapshot** (`page.content()`), so any content
gated behind interaction or animation that is not present at snapshot time is lost.

Concrete case: `https://stampsify.pl/` is an Angular SPA whose "Jak działa
Stampsify?" section is an `ngb-carousel` (ng-bootstrap) with **4 slides**
(`ngb-slide-0` … `ngb-slide-3`). ng-bootstrap renders **only the active slide**
in the DOM (via `ngTemplateOutlet`); inactive slides do not exist in the tree
until navigated to. At scrape time only one slide ("Elastyczne konta
pracownicze") was present — the other 3 (e.g. "Proste wydawanie wirtualnych
pieczątek") never entered `rawHtml`. This is **not** a parser bug: the text is
absent from `markdown`, `cleanedHtml`, **and** `rawHtml`.

The same class of problem affects sliders generally and FAQ/accordion content.

## Goal

A **generic** mechanism that recovers content hidden behind two of the most
common interactive patterns:

1. **Carousels / sliders** — ngb-carousel, Swiper, slick, splide, embla, generic
   Bootstrap-style carousels.
2. **FAQ / accordions** — `<details>`, Bootstrap collapse, ARIA accordions.

### Non-goals

- Tabs, "read more", modals, infinite scroll beyond existing scroll handling.
- Library-specific JS API driving (e.g. calling `swiper.slideNext()`).
- Any change to the HTTP API contract (request/response shape unchanged).

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Scope | Carousels/sliders **+** FAQ accordions |
| Mechanism | **Hybrid**: DOM accumulation over time **+** CSS/JS force-reveal, **no clicking as the primary mechanism** |
| Collector strategy | **Polling** (every ~400ms), not MutationObserver |
| Activation | **Always-on, adaptive**: force-reveal always; accumulation only when a rotating carousel is detected; ~0 overhead otherwise; works in `/scrape-site` |
| Slow carousels | **Short passive window + bounded "next" fallback**: ~3s passive, then advance the carousel's own "next" control only for slides still uncaptured |

## Architecture

### New module: `src/dynamic-reveal.ts`

Single entry point:

```ts
export async function revealDynamicContent(
  page: Page,
  opts?: { accumulateMs?: number; pollIntervalMs?: number; maxNextClicks?: number }
): Promise<{ carouselsFound: number; slidesRecovered: number; faqsExpanded: number }>;
```

Returns metrics for logging (`fastify.log`) only — **no API contract change**.

In-page logic (text normalization, hashing, slide dedup, nav-exclusion predicate,
indicator-count parsing) is written as **real TS functions** and injected into
`page.evaluate` via `.toString()`, so the same code is unit-testable without a DOM.

### Integration points (3 call sites)

`/scrape-site` does **not** reuse `scrapePage`; it has its own scraping code. So
`revealDynamicContent` is called in **three** places, each immediately before the
existing `page.content()`:

| File | Function | Placement |
|------|----------|-----------|
| `src/scraper.ts` | `scrapePage` | after `scrollToBottom`, **before** `removeHiddenElements` |
| `src/site-crawler.ts` | `scrapePageInContext` (~line 395) | after `scrollToBottom`, before `page.content()` |
| `src/site-crawler.ts` | inline homepage scrape (~line 487) | after `scrollToBottom`, before `page.content()` |

### Ordering constraint (critical)

Reveal must run **before** `removeHiddenElements()` (scraper) and the parser's
`preprocessForMarkdown` (which strips `[hidden]`, `.hidden`, `.visually-hidden`,
inline `visibility:hidden`, `aria-hidden`). Therefore everything revealed or
injected must end up with a **genuinely visible computed style** and must have
hiding attributes/classes removed — otherwise downstream cleanup deletes the
recovered content.

### Parser synergy

`html-parser.ts` carousel dedup (Jaccard 0.9, `deduplicateCarousels`) is left
unchanged. Recovered slides have **distinct** text → they survive; Swiper loop
**clones** (duplicates) get cleaned up. The existing dedup works in our favour.

## Phase 1 — Force-reveal (always, ~free)

Pure `page.evaluate`. Un-hides content that **is** in the DOM but collapsed
(Swiper/slick/splide with all slides present, FAQ/accordions).

Reveal technique per matched element:

```js
el.removeAttribute('hidden');
el.removeAttribute('aria-hidden');
el.classList.remove('hidden', 'visually-hidden');
el.style.setProperty('display', 'block', 'important');
el.style.setProperty('visibility', 'visible', 'important');
el.style.setProperty('opacity', '1', 'important');
el.style.setProperty('max-height', 'none', 'important');
el.style.setProperty('height', 'auto', 'important');
el.style.setProperty('overflow', 'visible', 'important');
el.style.setProperty('transform', 'none', 'important');
el.style.setProperty('position', 'static', 'important');
```

`important` is required because libraries hide via external stylesheets/classes.

Targets — **only inside recognized containers** (not blanket `[class*="slide"]`):

| Type | Container selectors | Element revealed |
|------|--------------------|------------------|
| Slider | `.swiper`, `.slick-slider`, `.splide`, `.embla`, `.carousel`, `[data-carousel]`, `[aria-roledescription="carousel"]` | `.swiper-slide`, `.slick-slide`, `.splide__slide`, `.embla__slide`, `.carousel-item` (skip `*-duplicate`) |
| FAQ | `<details>` | set `open` |
| FAQ | `[class*="accordion"]`, `[class*="faq"]`, `.collapse`, `[class*="collapse"]`, `[role="region"][aria-labelledby]` | content panel (+ `aria-expanded=true` on its trigger) |

### Safety rules (hard)

- **Skip navigation/menus:** an element is skipped if it is inside `<nav>`,
  `<header>`, `[role="navigation"]`, or if it/an ancestor has a class or id
  containing `nav`, `menu`, `dropdown`, `offcanvas`, or `drawer`. Eliminates the
  risk of expanding mobile nav menus.
- **Cap:** max ~200 revealed elements per page; on overflow, log and stop the phase.
- **Leave dialogs/modals alone:** `[role="dialog"]` untouched (cookie/popups are
  handled separately upstream).

### Signal for Phase 2

Phase 1 counts detected carousel containers and whether any is **rotating**:
indicator/`ngb-slide`/`[aria-label^="Slide"]` count > slides currently in DOM.
If yes → accumulation runs. If no carousels, or all slides already present
(Swiper) → accumulation skipped (zero overhead).

## Phase 2 — Accumulation (passive + bounded next-fallback)

Runs **only** when Phase 1 flagged a rotating carousel. Per detected container:

1. **Determine target slide count `N`** from indicators
   (`.carousel-indicators > *`, `[aria-label^="Slide"]`, `ngb-slide` count,
   `.swiper-pagination-bullet`). If undeterminable → `N = unknown` (convergence
   heuristic governs termination).

2. **Passive phase (~3s):** Node-driven poll every ~400ms (Node-driven because
   the fallback needs real clicks; keep both phases uniform). Each sample:
   `evaluate` returns `outerHTML` of slides currently in the container; dedup by
   **normalized-text hash** into an ordered map. **Early-exit** when collected ≥ `N`.

3. **Next-fallback (only if collected < N):** locate the container's "next" control:
   `.carousel-control-next`, `.swiper-button-next`, `.slick-next`,
   `.splide__arrow--next`, `.embla__button--next`, `[aria-label*="Next" i]`,
   `[class*="next"]` (scoped to the container). Loop: `click()` →
   `waitForTimeout(~600ms)` → capture → merge. Repeat at most `N - collected`
   times, **hard cap `max(N, 10)`**. Stop early when 2 consecutive clicks yield
   no new slide (convergence). If no "next" control is found → finish with what
   passive collected.

4. **Injection:** for each container, take the ordered unique collected slides
   **not** currently present and append them as **visible, static** nodes to the
   container (first-seen order), with forced reveal styles and a
   `data-recovered-slide` attribute (debug marker). They become part of
   `page.content()`; the parser reads them in order; Jaccard dedup cleans any
   residual duplicates.

### Time budget (real)

| Situation | Added time |
|-----------|-----------|
| No carousel (most pages) | ~0 (force-reveal only, <200ms) |
| Static carousel (Swiper, slides in DOM) | ~0 (Phase 1 suffices, accumulation skipped) |
| Rotating carousel, fast | ~3s (passive only) |
| Rotating carousel, slow (stampsify) | ~3s + ~N×0.6s ≈ **6–8s** |

Configurable params with defaults: `accumulateMs=3000`, `pollIntervalMs=400`,
`maxNextClicks=max(N,10)`. For `/scrape-site` the cost is per-page (CONCURRENCY=3
batches); the adaptive activation keeps no-carousel pages free.

## Error handling

- The whole reveal step is **best-effort**: any failure inside
  `revealDynamicContent` is caught and logged; the scrape proceeds with whatever
  DOM exists. Reveal must never fail a scrape that would otherwise succeed.
- Per-container failures are isolated (one bad carousel does not abort others).
- SSRF guard, cookie handling, screenshot, and existing waits are unchanged.

## Testing

Repo has **no unit-test framework** today (no runner in `package.json`, no
`.test`/`.spec` files); testing is integration-via-live-container (Make targets +
shell scripts) plus visual inspection of saved hero screenshots/outputs. We add
**zero new dependencies**.

### 1. Unit tests — `node --test` (built into Node 22)

Pure helpers extracted as real functions, injected into `evaluate` via
`.toString()`, covered by `tests/dynamic-reveal.test.ts` (run via a new
`npm test` script):

- text normalization + hash (slide dedup key)
- ordered slide-collection dedup
- nav/menu exclusion predicate
- indicator → `N` parser

This is the only departure from current convention, justified because the
dedup/parsing logic is correctness-critical and regression-prone.

### 2. Integration — new `make test-reveal URL=...`

Mirrors existing `test-*` targets: scrape + assert recovered slide text is in
markdown. Validation matrix:

| Site | Type | Criterion |
|------|------|-----------|
| stampsify.pl | ngb-carousel (rotating, slow) | markdown contains "Proste wydawanie…" + "Elastyczne konta…"; slide count ≥ 4 |
| a Swiper site | static (slides in DOM) | all slides in markdown; accumulation **skipped** |
| a FAQ/accordion site | collapse | FAQ answers present in markdown |
| a site with mobile menu | safety regression | menu **not** revealed (no nav noise) |
| a simple no-carousel page | perf regression | ~0 added time; markdown unchanged |

### 3. Acceptance (primary)

`make scrape URL=https://stampsify.pl/` → markdown contains all 4 slide headings
of the "Jak działa Stampsify?" section, including the previously-missing ones.
Final verification: rebuild image + real scrape (per `verification-before-completion`).

## Documentation follow-up

`CLAUDE.md` / `AGENTS.md` are already stale (omit `favicon.ts`, `ssrf-guard.ts`,
the `/favicon` endpoint, and the real `/scrape` response fields `rawHtml`,
`cleanedHtml`, `favicon`, `heroScreenshot`, `contentHash`). When adding
`dynamic-reveal.ts`, update the "Source Files" list and architecture section to
include it and fix these stale references in the same change.
