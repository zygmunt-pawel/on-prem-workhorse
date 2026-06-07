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

/** Signals (read from a DOM element) used to decide if it's a click-to-expand FAQ toggle. */
export interface FaqToggleSignals {
  /** Uppercase tagName, e.g. "BUTTON". */
  tag: string;
  /** Element has role="button". */
  roleButton: boolean;
  /** Element is an <a> with an href (clicking would navigate). */
  isLink: boolean;
  /** textContent of the element. */
  text: string;
  /** Value of the aria-expanded attribute, or null if absent. */
  ariaExpanded: string | null;
  /** Element contains a chevron/caret/arrow/plus toggle icon. */
  hasChevronIcon: boolean;
}

/**
 * True if an element looks like a collapsed FAQ/accordion toggle worth clicking
 * to mount its (otherwise absent) answer. Conservative to avoid clicking links,
 * non-interactive nodes, or non-FAQ controls. Already-open toggles return false.
 */
export function isFaqToggle(s: FaqToggleSignals): boolean {
  if (s.isLink) return false;
  const txt = s.text.replace(/\s+/g, " ").trim();
  if (!txt || txt.length > 200) return false;
  const clickable =
    s.tag === "BUTTON" ||
    s.tag === "SUMMARY" ||
    s.roleButton ||
    s.ariaExpanded !== null;
  if (!clickable) return false;
  // Standard accessible accordion: aria-expanded tells us the state directly.
  if (s.ariaExpanded === "true") return false; // already open — nothing to do
  if (s.ariaExpanded === "false") return true; // collapsed — expand it
  // Headless accordions (Framer/Radix/Tailwind) often lack aria-expanded: fall
  // back to a chevron icon paired with question-like / short header text.
  const looksQuestion = /\?$/.test(txt) || txt.split(" ").length <= 10;
  return s.hasChevronIcon && looksQuestion;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/** Strip HTML tags and decode a few common entities down to plain text. */
function htmlToText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract {question, answer} pairs from schema.org FAQPage JSON-LD text.
 * Handles a top-level FAQPage, an array of nodes, or an `@graph` wrapper, with
 * `mainEntity` as an array or a single Question. Answers are reduced to plain
 * text. Returns [] on invalid JSON or when no FAQPage/Questions are present.
 */
export function parseFaqJsonLd(jsonLdText: string): FaqEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonLdText);
  } catch {
    return [];
  }
  const asArray = (v: unknown): unknown[] =>
    Array.isArray(v) ? v : v == null ? [] : [v];
  const typesOf = (n: Record<string, unknown>): string[] =>
    asArray(n["@type"]).map((t) => String(t));

  // Candidate nodes: top-level item(s) plus any @graph children.
  const nodes: Record<string, unknown>[] = [];
  for (const top of asArray(data)) {
    if (top && typeof top === "object") {
      const obj = top as Record<string, unknown>;
      nodes.push(obj);
      for (const g of asArray(obj["@graph"])) {
        if (g && typeof g === "object") nodes.push(g as Record<string, unknown>);
      }
    }
  }

  const entries: FaqEntry[] = [];
  for (const node of nodes) {
    if (!typesOf(node).includes("FAQPage")) continue;
    for (const q of asArray(node.mainEntity)) {
      if (!q || typeof q !== "object") continue;
      const question = htmlToText(String((q as Record<string, unknown>).name ?? ""));
      const ans = asArray((q as Record<string, unknown>).acceptedAnswer)[0] as
        | Record<string, unknown>
        | undefined;
      const answer = htmlToText(String(ans?.text ?? ""));
      if (question && answer) entries.push({ question, answer });
    }
  }
  return entries;
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
const INJECTED = [isNavLike, pickSlideCount, isFaqToggle]
  .map((f) => f.toString())
  .join("\n");

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

/**
 * Builds an async script that clicks collapsed FAQ/accordion toggles to mount
 * their (otherwise absent-from-DOM) answers, captures each answer's text, then
 * re-collapses and injects the answer as a static visible node. Handles headless
 * accordions (Framer/Radix/Tailwind) where answers exist only after a click.
 */
function buildAccordionScript(): string {
  return `(async () => {
    ${INJECTED}
    const d = (ms) => new Promise((r) => setTimeout(r, ms));
    const MAX_TOGGLES = 40;
    const CHEVRON_SEL = [
      'svg[class*="chevron" i]','svg[class*="caret" i]','svg[class*="arrow" i]',
      'svg[class*="plus" i]','svg[class*="expand" i]','svg[class*="accordion" i]',
      'i[class*="chevron" i]','i[class*="caret" i]','i[class*="fa-plus" i]',
      'i[class*="fa-angle" i]','[class*="chevron" i]','[class*="caret" i]',
    ].join(',');

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

    const candidates = Array.from(
      document.querySelectorAll('button, summary, [role="button"], [aria-expanded]')
    );
    const toggles = [];
    for (const el of candidates) {
      if (inNav(el)) continue;
      const signals = {
        tag: el.tagName,
        roleButton: el.getAttribute('role') === 'button',
        isLink: el.tagName === 'A' && !!el.getAttribute('href'),
        text: el.textContent || '',
        ariaExpanded: el.getAttribute('aria-expanded'),
        hasChevronIcon: !!el.querySelector(CHEVRON_SEL),
      };
      if (isFaqToggle(signals)) toggles.push(el);
    }

    let expanded = 0;
    for (const t of toggles.slice(0, MAX_TOGGLES)) {
      // Watch progressively wider ancestors; the tightest one where the answer
      // is cleanly appended (after starts with before) wins. Broad containers
      // (whole list) self-reject because a mid-list insert breaks startsWith.
      const containers = [];
      let anc = t.parentElement;
      for (let i = 0; i < 4 && anc && anc !== document.body; i++) {
        containers.push(anc);
        anc = anc.parentElement;
      }
      if (!containers.length) continue;
      const befores = containers.map(
        (c) => (c.textContent || '').replace(/\\s+/g, ' ').trim()
      );

      try { t.click(); } catch (e) { continue; }
      await d(220);

      let answer = '';
      let host = containers[0];
      for (let i = 0; i < containers.length; i++) {
        const after = (containers[i].textContent || '').replace(/\\s+/g, ' ').trim();
        if (after.length > befores[i].length + 15 && after.startsWith(befores[i])) {
          answer = after.slice(befores[i].length).trim();
          host = containers[i];
          break;
        }
      }

      // Re-collapse so the live answer can't duplicate our injected static node.
      try { t.click(); } catch (e) {}

      if (answer && answer.length > 15) {
        const node = document.createElement('div');
        node.setAttribute('data-recovered-faq', '1');
        const p = document.createElement('p');
        p.textContent = answer;
        node.appendChild(p);
        (t.parentElement || host).insertBefore(node, t.nextSibling);
        expanded++;
      }
    }
    return { faqClicked: toggles.length, faqExpanded: expanded };
  })()`;
}

/** Builds a script returning the text of every application/ld+json block. */
function buildLdJsonExtractScript(): string {
  return `(() => {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      const t = s.textContent;
      if (t && t.trim()) out.push(t);
    });
    return out;
  })()`;
}

/**
 * Builds a script that injects FAQ answers parsed from JSON-LD. Each answer is
 * placed right after its matching question element when one is found, else in a
 * recovered section at the end. Answers already visible on the page are skipped.
 */
function buildInjectFaqScript(entries: FaqEntry[]): string {
  return `((entries) => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    // Dedup against the text that will SURVIVE removeHiddenElements (mirrors its
    // criteria): not against textContent (would include the JSON-LD <script>) nor
    // innerText (includes collapsed accordion panels that get stripped later).
    function survivingText(root) {
      let out = '';
      const walk = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (cs.opacity === '0') return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0 && cs.overflow === 'hidden') return;
        for (const n of el.childNodes) {
          if (n.nodeType === 3) out += ' ' + n.nodeValue;
          else if (n.nodeType === 1 && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') walk(n);
        }
      };
      walk(root);
      return norm(out);
    }
    const bodyText = survivingText(document.body);
    const candidates = Array.from(
      document.querySelectorAll('h2,h3,h4,h5,summary,button,dt,[role="button"],span,p,div,li')
    );
    let n = 0;
    const orphans = [];
    for (const e of entries) {
      const probe = norm(e.answer).slice(0, 40);
      if (probe && bodyText.includes(probe)) continue; // already present in surviving DOM
      const qn = norm(e.question);
      let target = null;
      for (const el of candidates) {
        if (norm(el.textContent) === qn && el.children.length <= 2) { target = el; break; }
      }
      if (target) {
        const ans = document.createElement('p');
        ans.setAttribute('data-recovered-faq', '1');
        ans.textContent = e.answer;
        (target.parentElement || document.body).insertBefore(ans, target.nextSibling);
        n++;
      } else {
        orphans.push(e);
      }
    }
    if (orphans.length) {
      const sec = document.createElement('section');
      sec.setAttribute('data-recovered-faq', '1');
      for (const e of orphans) {
        const q = document.createElement('h3'); q.textContent = e.question;
        const a = document.createElement('p'); a.textContent = e.answer;
        sec.appendChild(q); sec.appendChild(a); n++;
      }
      document.body.appendChild(sec);
    }
    return n;
  })(${JSON.stringify(entries)})`;
}

// ============ ORCHESTRATOR ============

export interface RevealOptions {
  accumulateMs?: number;
  pollIntervalMs?: number;
}

export interface RevealMetrics {
  carouselsFound: number;
  slidesRecovered: number;
  /** FAQ/slider panels force-revealed in place (already in DOM). */
  faqsExpanded: number;
  /** FAQ answers recovered by clicking a toggle that mounts them on demand. */
  faqsClickExpanded: number;
  /** FAQ answers recovered from schema.org FAQPage JSON-LD. */
  faqsFromSchema: number;
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
    faqsClickExpanded: 0,
    faqsFromSchema: 0,
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

    // Click-to-expand FAQ/accordion toggles whose answers are mounted only on
    // click (headless Framer/Radix/Tailwind accordions, not in the DOM until then).
    const acc = (await page.evaluate(buildAccordionScript())) as {
      faqClicked: number;
      faqExpanded: number;
    };
    metrics.faqsClickExpanded = acc.faqExpanded;

    // Recover FAQ answers from schema.org FAQPage JSON-LD (parsed in Node, then
    // injected): reliable even when the rendered accordion mounts answers on click.
    const ldTexts = (await page.evaluate(buildLdJsonExtractScript())) as string[];
    const faqEntries: FaqEntry[] = [];
    const seenQuestions = new Set<string>();
    for (const t of ldTexts) {
      for (const e of parseFaqJsonLd(t)) {
        const key = normalizeText(e.question);
        if (key && !seenQuestions.has(key)) {
          seenQuestions.add(key);
          faqEntries.push(e);
        }
      }
    }
    if (faqEntries.length) {
      metrics.faqsFromSchema = (await page.evaluate(
        buildInjectFaqScript(faqEntries)
      )) as number;
    }
  } catch {
    // best-effort — swallow and return whatever metrics we have
  }

  return metrics;
}
