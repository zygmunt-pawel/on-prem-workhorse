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
