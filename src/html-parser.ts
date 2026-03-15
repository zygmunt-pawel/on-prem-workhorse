import * as cheerio from "cheerio";
import TurndownService from "turndown";
// @ts-expect-error - no types available for turndown-plugin-gfm
import { gfm } from "turndown-plugin-gfm";
import { createHash } from "node:crypto";

// ============ TYPES ============

export interface Favicon {
  url: string | null;
  dataUri: string | null;
}

export interface ParsedPage {
  source: {
    inputUrl: string;
    canonicalUrl: string | null;
    scrapedAt: string;
    language: string | null;
  };
  markdown: string;
  cleanedHtml: string;
  rawHtml: string;
  favicon: Favicon;
  heroScreenshot: string | null;
  contentHash: string;
}

export interface ParserOptions {
  /** Remove duplicate content from carousels/sliders */
  deduplicateCarousels: boolean;
  /** Similarity threshold for carousel deduplication (0.0-1.0) */
  carouselSimilarityThreshold: number;
  /** Add section markers (## Section Name) to output */
  addSectionMarkers: boolean;
  /** Convert inline span sequences to markdown lists */
  normalizeInlineLists: boolean;
  /** Minimum characters for an item to be considered a list item */
  listItemMinLength: number;
  /** Generate cleaned HTML output (set false to skip for performance) */
  generateCleanedHtml: boolean;
  /** Include raw HTML in output (set false to skip for performance) */
  includeRawHtml: boolean;
}

const DEFAULT_PARSER_OPTIONS: ParserOptions = {
  deduplicateCarousels: true,
  carouselSimilarityThreshold: 0.9,
  addSectionMarkers: false,
  normalizeInlineLists: true,
  listItemMinLength: 3,
  generateCleanedHtml: true,
  includeRawHtml: true,
};

// ============ CONSTANTS ============

// Size limits to prevent OOM and excessive OpenAI token usage
const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_MARKDOWN_LENGTH = 15_000; // 15k characters per page

// Tags to completely remove (including their content)
const TAGS_TO_REMOVE = ["script", "style", "noscript", "iframe", "svg", "canvas", "template"];

// Attributes to keep on elements (for cleanedHtml)
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt"],
  meta: ["name", "property", "content", "charset"],
  link: ["rel", "href"],
  html: ["lang"],
  form: ["action", "method"],
  button: ["type"],
  time: ["datetime"],
  data: ["value"],
};

// ============ TURNDOWN SETUP ============

function createTurndownService(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  // Add GFM support (tables, strikethrough, task lists)
  turndown.use(gfm);

  // Remove unwanted elements entirely
  turndown.remove(TAGS_TO_REMOVE as TurndownService.Filter);

  // Custom rule for mailto/tel links - show contact info inline
  turndown.addRule("contactLinks", {
    filter: (node) => {
      if (node.nodeName !== "A") return false;
      const href = node.getAttribute("href") || "";
      return href.startsWith("mailto:") || href.startsWith("tel:");
    },
    replacement: (content, node) => {
      const href = (node as Element).getAttribute("href") || "";
      const value = href.replace(/^(mailto:|tel:)/, "").split("?")[0];
      const text = content.trim();
      // If text is same as value, just show once
      if (text.toLowerCase() === value.toLowerCase()) {
        return value;
      }
      return `${text} (${value})`;
    },
  });

  // Strip link markup, preserve text content only
  turndown.addRule("stripLinks", {
    filter: "a",
    replacement: (content) => {
      const text = content ? content.trim() : "";
      return text ? `${text} ` : "";
    },
  });

  // Strip button markup, preserve text content only
  turndown.addRule("removeButtons", {
    filter: "button",
    replacement: (content) => {
      const text = content ? content.trim() : "";
      return text ? `${text} ` : "";
    },
  });

  // Remove form inputs completely - they don't carry meaningful content
  turndown.addRule("formInputs", {
    filter: ["input", "textarea"],
    replacement: () => "",
  });

  // Remove labels completely - they're associated with inputs which we also remove
  turndown.addRule("removeLabels", {
    filter: "label",
    replacement: () => "",
  });

  // Strip images but preserve alt text (often descriptive for product pages)
  turndown.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as Element).getAttribute("alt");
      return alt ? alt.trim() + " " : "";
    },
  });

  // Custom rule for section start markers
  turndown.addRule("sectionStartMarkers", {
    filter: (node) => {
      return (
        node.nodeName === "DIV" && node.getAttribute("data-section-marker") === "start"
      );
    },
    replacement: (_content, node) => {
      const id = (node as Element).getAttribute("data-section-id") || "0";
      const tag = (node as Element).getAttribute("data-section-tag") || "section";
      return `\n\n<!-- ===== SECTION ${id}: ${tag} ===== -->\n\n`;
    },
  });

  // Custom rule for section end markers
  turndown.addRule("sectionEndMarkers", {
    filter: (node) => {
      return (
        node.nodeName === "DIV" && node.getAttribute("data-section-marker") === "end"
      );
    },
    replacement: (_content, node) => {
      const id = (node as Element).getAttribute("data-section-id") || "0";
      return `\n\n<!-- ===== END ${id} ===== -->\n\n`;
    },
  });

  return turndown;
}

// ============ PREPROCESSING ============

function preprocessForMarkdown($: cheerio.CheerioAPI): void {
  // Remove tags that should be completely removed (with content)
  TAGS_TO_REMOVE.forEach((tag) => {
    $(tag).remove();
  });

  // Remove form inputs and their labels - they don't provide meaningful content
  $("input, textarea, label").remove();

  // Remove hidden elements (inline styles + common hidden CSS classes)
  $([
    '[hidden]',
    '[style*="display: none"]',
    '[style*="display:none"]',
    '[style*="visibility: hidden"]',
    '[style*="visibility:hidden"]',
    '[style*="opacity: 0"]',
    '[style*="opacity:0"]',
    '[style*="clip: rect(0"]',
    '[style*="clip:rect(0"]',
    '[style*="clip-path: inset(100%)"]',
    '[style*="clip-path:inset(100%)"]',
    '[style*="overflow: hidden"][style*="height: 0"]',
    '[style*="overflow:hidden"][style*="height:0"]',
    '.hidden',
    '.sr-only',
    '.visually-hidden',
    '.screen-reader-text',
    '.invisible',
    '.d-none',
  ].join(', ')).remove();

  // Remove aria-hidden="true" only on likely-decorative elements (icons, small spans)
  // Avoid removing larger containers that may have visible content
  $('[aria-hidden="true"]').each((_, el) => {
    const $el = $(el);
    const tagName = el.type === "tag" ? el.tagName.toLowerCase() : "";
    const isDecorative =
      tagName === "svg" ||
      tagName === "i" ||
      tagName === "span" && $el.text().trim().length <= 2;
    if (isDecorative) {
      $el.remove();
    }
  });

  // Inject space between adjacent <a> and <button> tags to prevent text merging
  // (e.g., <a>Features</a><a>Pricing</a> → "Features Pricing" not "FeaturesPricing")
  $("a + a").each((_, el) => { $(el).before(" "); });
  $("button + button").each((_, el) => { $(el).before(" "); });

  // Remove all nav elements - navigation adds noise for LLM consumption
  $("nav").remove();

  // Remove comments
  $("*")
    .contents()
    .filter(function () {
      return this.type === "comment";
    })
    .remove();

  // Remove empty elements (but keep semantic ones like br, hr, img)
  const keepEmptyTags = ["br", "hr", "img", "input", "meta", "link", "td", "th"];
  $("p, div, span, li, td, th").each((_, el) => {
    const $el = $(el);
    const tagName = el.type === "tag" ? el.tagName.toLowerCase() : "";

    if (
      !keepEmptyTags.includes(tagName) &&
      !$el.find("img").length &&
      !$el.text().trim()
    ) {
      $el.remove();
    }
  });
}

// ============ CAROUSEL DEDUPLICATION ============

type CheerioElement = ReturnType<cheerio.CheerioAPI>extends cheerio.Cheerio<infer T> ? T : never;

/**
 * Gets a normalized text signature for content comparison
 */
function getContentSignature($: cheerio.CheerioAPI, el: CheerioElement): string {
  return $(el)
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .substring(0, 500);
}

/**
 * Calculates Jaccard similarity between two strings (based on words)
 */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));

  const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Removes duplicate children from a parent element based on content similarity
 */
function deduplicateSiblingContent(
  $: cheerio.CheerioAPI,
  parent: CheerioElement,
  threshold: number
): void {
  const children = $(parent).children();
  if (children.length < 2) return;

  const signatures: Map<string, CheerioElement[]> = new Map();

  children.each((_, child) => {
    const sig = getContentSignature($, child);
    if (sig.length < 20) return; // Skip very short content

    // Find similar existing signature
    let matched = false;
    for (const [existingSig, elements] of signatures) {
      if (calculateSimilarity(sig, existingSig) >= threshold) {
        elements.push(child);
        matched = true;
        break;
      }
    }

    if (!matched) {
      signatures.set(sig, [child]);
    }
  });

  // Remove duplicates (keep first occurrence)
  for (const [, elements] of signatures) {
    if (elements.length > 1) {
      elements.slice(1).forEach((el) => $(el).remove());
    }
  }
}

/**
 * Detects and removes duplicate carousel/slider content
 */
function deduplicateCarousels($: cheerio.CheerioAPI, threshold: number): void {
  // Look for parent elements with multiple similar children
  $("div, section").each((_, parent) => {
    const children = $(parent).children("div, ul, ol");
    if (children.length >= 2) {
      deduplicateSiblingContent($, parent, threshold);
    }
  });
}

// ============ SECTION DETECTION ============

/**
 * Detects semantic sections and inserts marker divs for Turndown to convert
 */
function detectAndMarkSections($: cheerio.CheerioAPI): void {
  const semanticTags = ["header", "main", "section", "footer", "article"];
  let sectionCounter = 0;

  semanticTags.forEach((tag) => {
    $(tag).each((_, el) => {
      // Skip if nested inside another semantic tag (avoid double-marking)
      const $el = $(el);
      const hasSemanticParent = $el.parents(semanticTags.join(",")).length > 0;
      if (hasSemanticParent && tag === "section") return;

      sectionCounter++;
      const tagName = el.type === "tag" ? (el as { tagName: string }).tagName.toLowerCase() : "section";

      // Insert start marker at the beginning and end marker at the end
      // Use a zero-width space to prevent Turndown from ignoring empty divs
      $el.prepend(`<div data-section-marker="start" data-section-id="${sectionCounter}" data-section-tag="${tagName}">\u200B</div>`);
      $el.append(`<div data-section-marker="end" data-section-id="${sectionCounter}">\u200B</div>`);
    });
  });
}

// ============ LIST NORMALIZATION ============

/**
 * Detects inline span/div sequences and converts them to proper lists
 * Also deduplicates if content repeats (carousel pattern)
 */
function normalizeInlineLists($: cheerio.CheerioAPI, minItemLength: number): void {
  $("div").each((_, parent) => {
    const $parent = $(parent);
    const children = $parent.children("span, div, a").filter((_, child) => {
      // Only direct text-containing elements, not containers
      return $(child).children().length === 0;
    });

    if (children.length < 3) return;

    // Check if all children look like list items
    const items: string[] = [];
    let isListLike = true;

    children.each((_, child) => {
      const text = $(child).text().trim();
      if (text.length < minItemLength || text.length > 100) {
        isListLike = false;
        return false; // break
      }
      items.push(text);
    });

    if (!isListLike || items.length < 3) return;

    // Deduplicate items (carousel often has 2x same content)
    const uniqueItems = [...new Set(items)];

    // Only convert if we have reasonable list-like content
    if (uniqueItems.length >= 3) {
      // Replace children with proper list
      children.remove();
      const $ul = $("<ul>");
      uniqueItems.forEach((item) => {
        $ul.append(`<li>${item}</li>`);
      });
      $parent.append($ul);
    }
  });
}

// ============ FAVICON EXTRACTION ============

/**
 * Extracts favicon URL from the page, resolving relative URLs to absolute.
 */
function extractFaviconUrl($: cheerio.CheerioAPI, baseUrl: string): string | null {
  // Priority order for favicon selectors
  const selectors = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
  ];

  for (const selector of selectors) {
    const href = $(selector).attr('href');
    if (href) {
      try {
        // Resolve relative URLs to absolute
        return new URL(href, baseUrl).href;
      } catch {
        // Invalid URL, continue to next selector
        continue;
      }
    }
  }

  // Fallback: try /favicon.ico
  try {
    return new URL('/favicon.ico', baseUrl).href;
  } catch {
    return null;
  }
}

// ============ CLEAN HTML ============

function cleanHtml($: cheerio.CheerioAPI): string {
  // Remove tags that should be completely removed (with content)
  TAGS_TO_REMOVE.forEach((tag) => {
    $(tag).remove();
  });

  // Remove form inputs and their labels - they don't provide meaningful content
  $("input, textarea, label").remove();

  // Remove comments
  $("*")
    .contents()
    .filter(function () {
      return this.type === "comment";
    })
    .remove();

  // Clean attributes from all elements
  $("*").each((_, el) => {
    if (el.type !== "tag") return;

    const $el = $(el);
    const tagName = el.tagName.toLowerCase();
    const allowedAttrs = ALLOWED_ATTRIBUTES[tagName] || [];

    // Get all current attributes
    const attribs = el.attribs || {};

    // Remove all attributes except allowed ones
    Object.keys(attribs).forEach((attr) => {
      if (!allowedAttrs.includes(attr)) {
        $el.removeAttr(attr);
      }
    });
  });

  // Remove empty elements (but keep semantic ones like br, hr)
  const keepEmptyTags = ["br", "hr", "img", "input", "meta", "link"];
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    const $el = $(el);
    const tagName = el.tagName.toLowerCase();

    if (
      !keepEmptyTags.includes(tagName) &&
      !$el.children().length &&
      !$el.text().trim()
    ) {
      $el.remove();
    }
  });

  return $.html();
}

// ============ MARKDOWN POST-PROCESSING ============

/**
 * Post-processes markdown output for cleanup
 */
function postprocessMarkdown(markdown: string): string {
  let result = markdown;

  // Step 1: Remove empty list items (lines that are just dashes, "- -", "- - -", etc.)
  result = result.replace(/^-(\s*-)*\s*$/gm, "");

  // Step 1b: Normalize list items - remove extra spaces after dash, keep single space
  result = result.replace(/^-\s{2,}/gm, "- ");

  // Step 1c: Collapse multiple spaces within a line to single space
  result = result.replace(/ {2,}/g, " ");

  // Step 2: Collapse multiple blank lines to single blank line
  result = result.replace(/\n{3,}/g, "\n\n");

  // Step 3: Remove empty sections (SECTION immediately followed by END with same id)
  result = result.replace(
    /<!-- ===== SECTION (\d+): \w+ ===== -->\s*<!-- ===== END \1 ===== -->/g,
    ""
  );

  // Step 3b: Remove sections that only contain whitespace/placeholders
  // Match sections where content between markers is only whitespace or "Video placeholder"
  result = result.replace(
    /<!-- ===== SECTION (\d+): \w+ ===== -->\s*(Video placeholder\s*)*<!-- ===== END \1 ===== -->/g,
    ""
  );

  // Step 3c: Remove sections that only contain empty list markers (- or - -)
  // These are leftover artifacts from removed links/buttons/images in lists
  result = result.replace(
    /<!-- ===== SECTION (\d+): \w+ ===== -->\s*([-\s]*\n)*\s*<!-- ===== END \1 ===== -->/g,
    ""
  );

  // Step 4: Renumber sections sequentially (1, 2, 3, ...)
  let newSectionNum = 0;
  const sectionMapping = new Map<string, string>();

  // First pass: find all section starts and create mapping
  const sectionStartRegex = /<!-- ===== SECTION (\d+): (\w+) ===== -->/g;
  let match;
  while ((match = sectionStartRegex.exec(result)) !== null) {
    const oldNum = match[1];
    if (!sectionMapping.has(oldNum)) {
      newSectionNum++;
      sectionMapping.set(oldNum, String(newSectionNum));
    }
  }

  // Second pass: replace old numbers with new sequential numbers
  for (const [oldNum, newNum] of sectionMapping) {
    result = result.replace(
      new RegExp(`<!-- ===== SECTION ${oldNum}: (\\w+) ===== -->`, 'g'),
      `<!-- ===== SECTION ${newNum}: $1 ===== -->`
    );
    result = result.replace(
      new RegExp(`<!-- ===== END ${oldNum} ===== -->`, 'g'),
      `<!-- ===== END ${newNum} ===== -->`
    );
  }

  // Step 5: Ensure proper spacing around section markers (blank line before and after)
  result = result.replace(/([^\n])\n(<!-- ===== )/g, "$1\n\n$2");
  result = result.replace(/(===== -->)\n([^\n])/g, "$1\n\n$2");

  // Step 6: Remove blank lines between consecutive list items
  // Match a list item followed by blank line(s) followed by another list item
  result = result.replace(/^(- .+)\n\n+(- )/gm, "$1\n$2");
  // Repeat to catch multiple consecutive items with blank lines
  result = result.replace(/^(- .+)\n\n+(- )/gm, "$1\n$2");
  result = result.replace(/^(- .+)\n\n+(- )/gm, "$1\n$2");

  // Step 7: Ensure blank line BEFORE headings (but not after)
  // First, add blank line before headings if not present
  result = result.replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2");

  // Step 8: Remove blank line between heading and following content (non-heading, non-section-marker)
  // Match heading followed by blank line followed by text that isn't a heading or section marker
  result = result.replace(/(^#{1,6} .+)\n\n+(?!(#{1,6} |<!-- ===== |$))/gm, "$1\n");

  return result.trim();
}

// ============ MAIN FUNCTION ============

// Singleton turndown instance for reuse
let turndownInstance: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownInstance) {
    turndownInstance = createTurndownService();
  }
  return turndownInstance;
}

/**
 * Parses HTML and converts it to clean Markdown for LLM consumption.
 * Also returns cleaned HTML for debugging/raw access.
 */
export function parseHtml(
  html: string,
  baseUrl: string,
  options: Partial<ParserOptions> = {}
): ParsedPage {
  const opts = { ...DEFAULT_PARSER_OPTIONS, ...options };

  // Truncate oversized HTML to prevent OOM
  const truncatedHtml = html.length > MAX_HTML_SIZE ? html.slice(0, MAX_HTML_SIZE) : html;

  // Load HTML for markdown conversion
  const $ = cheerio.load(truncatedHtml);

  // Extract source metadata before preprocessing
  const canonical = $('link[rel="canonical"]').attr("href") || null;
  const language =
    $("html").attr("lang") ||
    $('meta[name="language"]').attr("content") ||
    $('meta[http-equiv="content-language"]').attr("content") ||
    null;

  // Extract favicon before preprocessing (preprocessing doesn't touch <link> tags)
  const faviconUrl = extractFaviconUrl($, baseUrl);

  // Preprocess for markdown conversion
  preprocessForMarkdown($);

  // Carousel deduplication
  if (opts.deduplicateCarousels) {
    deduplicateCarousels($, opts.carouselSimilarityThreshold);
  }

  // Section detection
  if (opts.addSectionMarkers) {
    detectAndMarkSections($);
  }

  // List normalization
  if (opts.normalizeInlineLists) {
    normalizeInlineLists($, opts.listItemMinLength);
  }

  // Convert to markdown using turndown
  const turndown = getTurndown();

  // Get body content (or full document if no body)
  const bodyHtml = $("body").html() || $.html();
  let markdown = turndown.turndown(bodyHtml);

  // Post-process markdown
  markdown = postprocessMarkdown(markdown);

  // Truncate oversized markdown to prevent excessive OpenAI token usage
  if (markdown.length > MAX_MARKDOWN_LENGTH) {
    markdown = markdown.slice(0, MAX_MARKDOWN_LENGTH);
  }

  // Generate cleaned HTML (reload truncated copy to avoid mutation issues)
  let cleanedHtml = "";
  if (opts.generateCleanedHtml) {
    const $clean = cheerio.load(truncatedHtml);
    cleanedHtml = cleanHtml($clean);
  }

  const contentHash = createHash("sha256").update(html).digest("hex");

  return {
    source: {
      inputUrl: baseUrl,
      canonicalUrl: canonical,
      scrapedAt: new Date().toISOString(),
      language,
    },
    markdown,
    cleanedHtml,
    rawHtml: opts.includeRawHtml ? html : "",
    favicon: { url: faviconUrl, dataUri: null },
    heroScreenshot: null,
    contentHash,
  };
}
