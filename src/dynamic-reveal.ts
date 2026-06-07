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
