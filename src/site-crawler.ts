import { createHash } from "node:crypto";
import {
  createStealthBrowser,
  closeStealthBrowser,
  setupResourceBlocking,
  type StealthBrowser,
} from "./stealth.js";
import { scrollToBottom, fetchFaviconDataUri } from "./scraper.js";
import { parseHtml, type Favicon } from "./html-parser.js";
import { installSsrfGuard } from "./ssrf-guard.js";
import { parseSitemap } from "./sitemap-parser.js";
import { extractNavLinks } from "./nav-extractor.js";

// ============ TYPES ============

export interface ScrapeSiteOptions {
  /** Overall timeout for the entire operation in ms */
  timeout: number;
  /** Timeout for each individual page scrape in ms */
  pageTimeout: number;
  /** Max number of subpages to scrape (excluding homepage) */
  maxPages: number;
  /** Optional proxy URL */
  proxyUrl?: string;
  /** Max markdown characters per page (null = no limit) */
  maxChars?: number | null;
}

export interface PageResult {
  url: string;
  label: string;
  markdown: string;
  error?: string;
}

export interface ScrapeSiteResult {
  pages: PageResult[];
  favicon: Favicon;
  discoveryMethod: "sitemap" | "nav-links" | "homepage-only";
  totalPagesDiscovered: number;
  totalPagesScraped: number;
}

// ============ PAGE SELECTION ============

/** Priority scores for URL path segments. Higher = more valuable. */
const PRIORITY_MAP: Record<string, number> = {
  features: 10,
  pricing: 9,
  about: 8,
  "about-us": 8,
  "use-cases": 8,
  usecases: 8,
  solutions: 8,
  integrations: 7,
  product: 7,
  "how-it-works": 7,
  customers: 6,
  testimonials: 6,
  faq: 5,
  "why-us": 7,
  enterprise: 6,
  platform: 7,
  overview: 7,
  demo: 5,
  tour: 5,
  "case-studies": 6,
  partners: 5,
  comparison: 7,
  alternatives: 7,
  "vs": 6,
};

/** Negative-priority patterns to skip */
const SKIP_PATTERNS: string[] = [
  "blog",
  "docs",
  "documentation",
  "changelog",
  "careers",
  "jobs",
  "legal",
  "privacy",
  "terms",
  "cookie",
  "login",
  "signin",
  "signup",
  "register",
  "auth",
  "dashboard",
  "app",
  "admin",
  "support",
  "help",
  "contact",
  "press",
  "news",
  "events",
  "webinar",
  "podcast",
  "newsletter",
  "api",
  "developer",
  "status",
  "security",
  "compliance",
  "sitemap",
  "feed",
  "rss",
];

/** File extensions to skip */
const SKIP_EXTENSIONS = new Set([
  ".pdf",
  ".xml",
  ".json",
  ".csv",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".mp4",
  ".mp3",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

const LOCALE_PATTERN = /^[a-z]{2}(-[a-z]{2})?$/;

/** Well-known non-English locale codes (ISO 639-1 + common combos) */
const KNOWN_NON_EN_LOCALES = new Set([
  "fr", "de", "es", "it", "pt", "nl", "pl", "cs", "uk", "ru",
  "ja", "ko", "zh", "ar", "hi", "sv", "da", "no", "nb", "nn",
  "fi", "tr", "he", "th", "vi", "id", "ms", "ro", "bg", "hr",
  "sk", "sl", "et", "lt", "lv", "el", "hu", "ca", "eu", "gl",
  "pt-br", "zh-cn", "zh-tw", "fr-fr", "de-de", "es-es", "it-it",
  "pt-pt", "nl-nl", "fr-ca",
]);

function detectNonEnglishLocales(
  urls: string[],
  homepageUrl: string
): Set<string> | null {
  // Check if homepage itself has a locale prefix
  let homepageLocale: string | null = null;
  try {
    const homeSegments = new URL(homepageUrl).pathname
      .split("/")
      .filter((s) => s.length > 0);
    if (homeSegments.length > 0 && LOCALE_PATTERN.test(homeSegments[0])) {
      homepageLocale = homeSegments[0].toLowerCase();
    }
  } catch {
    // ignore
  }

  // Collect all locale-like first segments from discovered URLs
  const firstSegments = new Set<string>();
  for (const url of urls) {
    try {
      const segments = new URL(url).pathname
        .split("/")
        .filter((s) => s.length > 0);
      if (segments.length > 0 && LOCALE_PATTERN.test(segments[0])) {
        firstSegments.add(segments[0].toLowerCase());
      }
    } catch {
      continue;
    }
  }

  if (firstSegments.size === 0) return null;

  // Case 1: Explicit "en" prefix exists → filter all non-English locales
  const hasEnglish = [...firstSegments].some(
    (s) => s === "en" || s.startsWith("en-")
  );
  if (hasEnglish) {
    const nonEnglish = new Set<string>();
    for (const seg of firstSegments) {
      if (seg !== "en" && !seg.startsWith("en-")) {
        nonEnglish.add(seg);
      }
    }
    return nonEnglish.size > 0 ? nonEnglish : null;
  }

  // Case 2: Homepage has no locale prefix and we see 2+ known non-English
  // locale segments → site serves English at root, translations under /fr/ etc.
  if (!homepageLocale) {
    const knownLocales = new Set<string>();
    for (const seg of firstSegments) {
      if (KNOWN_NON_EN_LOCALES.has(seg)) {
        knownLocales.add(seg);
      }
    }
    if (knownLocales.size >= 2) {
      return knownLocales;
    }
  }

  return null;
}

interface ScoredPage {
  url: string;
  priority: number;
  label: string;
}

function scoreAndSelectPages(
  urls: string[],
  homepageUrl: string,
  maxPages: number
): ScoredPage[] {
  const homepageNormalized = normalizeForComparison(homepageUrl);
  const scored: ScoredPage[] = [];

  const nonEnglishLocales = detectNonEnglishLocales(urls, homepageUrl);
  if (nonEnglishLocales) {
    console.log(
      `Locale filter: skipping non-English prefixes: ${[...nonEnglishLocales].join(", ")}`
    );
  }

  for (const url of urls) {
    // Skip homepage (already scraped separately)
    if (normalizeForComparison(url) === homepageNormalized) continue;

    const parsed = safeParseUrl(url);
    if (!parsed) continue;

    const pathname = parsed.pathname;

    // Skip URLs with query params
    if (parsed.search) continue;

    // Skip non-HTML extensions
    const ext = pathname.substring(pathname.lastIndexOf(".")).toLowerCase();
    if (ext.length > 1 && SKIP_EXTENSIONS.has(ext)) continue;

    // Skip deep paths (>4 segments)
    const segments = pathname
      .split("/")
      .filter((s) => s.length > 0);
    if (segments.length > 4) continue;

    // Check skip patterns using full path segment matching
    // (avoids false positives like "app" matching "apple-integration")
    const lowerSegments = segments.map((s) => s.toLowerCase());
    const shouldSkip = lowerSegments.some((s) => SKIP_PATTERNS.includes(s));
    if (shouldSkip) continue;

    // Skip non-English locale pages
    if (nonEnglishLocales) {
      const firstSegment = segments[0]?.toLowerCase();
      if (firstSegment && nonEnglishLocales.has(firstSegment)) continue;
    }

    // Calculate priority from path segments
    let priority = 0;
    for (const segment of segments) {
      const normalizedSegment = segment.toLowerCase();
      if (normalizedSegment in PRIORITY_MAP) {
        priority = Math.max(priority, PRIORITY_MAP[normalizedSegment]);
      }
    }

    // If no known priority, give a small base score (still valuable if from sitemap/nav)
    if (priority === 0 && segments.length <= 2) {
      priority = 1;
    }

    const label = generateLabel(segments);
    scored.push({ url, priority, label });
  }

  // Sort by priority descending, then by URL length (shorter = more general)
  scored.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.url.length - b.url.length;
  });

  // Diversity filter: max 2 pages per first path segment to prevent
  // e.g. /features/* or /pricing/* from consuming all slots
  const MAX_PER_PREFIX = 2;
  const prefixCounts = new Map<string, number>();
  const diverse: ScoredPage[] = [];
  const overflow: ScoredPage[] = [];

  for (const page of scored) {
    const prefix = getFirstSegment(page.url);
    const count = prefixCounts.get(prefix) || 0;
    if (count < MAX_PER_PREFIX) {
      diverse.push(page);
      prefixCounts.set(prefix, count + 1);
    } else {
      overflow.push(page);
    }
  }

  // Fill remaining slots from overflow if diverse doesn't have enough
  const result = diverse.slice(0, maxPages);
  if (result.length < maxPages) {
    result.push(...overflow.slice(0, maxPages - result.length));
  }

  return result;
}

function getFirstSegment(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter((s) => s.length > 0);
    return (segments[0] || "").toLowerCase();
  } catch {
    return "";
  }
}

function generateLabel(segments: string[]): string {
  if (segments.length === 0) return "Homepage";
  // Take the last meaningful segment and convert to title case
  const last = segments[segments.length - 1];
  return last
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeForComparison(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    return `${parsed.origin}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// ============ SCRAPING ============

const CONCURRENCY = 3;

async function scrapePageInContext(
  context: import("playwright-ghost").BrowserContext,
  url: string,
  timeout: number,
  maxChars?: number | null
): Promise<PageResult & { favicon: Favicon }> {
  const page = await context.newPage();
  const ssrf = installSsrfGuard(page);
  try {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });
    } catch (err) {
      if (ssrf.blocked) throw new Error(ssrf.blocked);
      throw err;
    }
    await page.waitForTimeout(2000);
    await scrollToBottom(page);
    await page.waitForTimeout(500);

    const rawHtml = await page.content();
    const parsed = parseHtml(rawHtml, url, {
      generateCleanedHtml: false,
      includeRawHtml: false,
      ...(maxChars !== undefined && { maxChars }),
    });

    return {
      url,
      label: "", // Will be set by caller
      markdown: parsed.markdown,
      favicon: parsed.favicon,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      url,
      label: "",
      markdown: "",
      favicon: { url: null, dataUri: null },
      error: err.message,
    };
  } finally {
    await page.close();
  }
}

async function scrapeInBatches(
  context: import("playwright-ghost").BrowserContext,
  pages: ScoredPage[],
  pageTimeout: number,
  maxChars?: number | null
): Promise<PageResult[]> {
  const results: PageResult[] = [];

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (scoredPage) => {
        const result = await scrapePageInContext(
          context,
          scoredPage.url,
          pageTimeout,
          maxChars
        );
        return {
          url: result.url,
          label: scoredPage.label,
          markdown: result.markdown,
          ...(result.error ? { error: result.error } : {}),
        };
      })
    );
    results.push(...batchResults);
  }

  return results;
}

// ============ MAIN FUNCTION ============

export async function scrapeSite(
  url: string,
  options: ScrapeSiteOptions
): Promise<ScrapeSiteResult> {
  let stealthBrowser: StealthBrowser | null = null;

  try {
    stealthBrowser = await createStealthBrowser({
      timeout: options.timeout,
      proxyUrl: options.proxyUrl,
    });
    const { context, page: homePage } = stealthBrowser;

    // Block heavy resources (images, fonts, media) — site crawler only needs HTML
    await setupResourceBlocking(context);

    const ssrf = installSsrfGuard(homePage);

    // Step 1: Scrape homepage
    try {
      await homePage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeout,
      });
    } catch (err) {
      if (ssrf.blocked) throw new Error(ssrf.blocked);
      throw err;
    }
    await homePage.waitForTimeout(2000);
    await scrollToBottom(homePage);
    await homePage.waitForTimeout(500);

    const homepageHtml = await homePage.content();
    const homepageParsed = parseHtml(homepageHtml, url, {
      ...(options.maxChars !== undefined && { maxChars: options.maxChars }),
    });

    const homepageResult: PageResult = {
      url,
      label: "Homepage",
      markdown: homepageParsed.markdown,
    };

    // Fetch favicon as base64 data URI
    const faviconDataUri = await fetchFaviconDataUri(
      context,
      homepageParsed.favicon.url,
      url
    );
    const favicon: Favicon = { url: homepageParsed.favicon.url, dataUri: faviconDataUri };

    // If maxPages is 0, return homepage only
    if (options.maxPages <= 0) {
      return {
        pages: [homepageResult],
        favicon,
        discoveryMethod: "homepage-only",
        totalPagesDiscovered: 0,
        totalPagesScraped: 1,
      };
    }

    // Step 2: Discover subpages
    let discoveredUrls: string[] = [];
    let discoveryMethod: ScrapeSiteResult["discoveryMethod"] = "homepage-only";

    // Try sitemap first
    const sitemapUrls = await parseSitemap(url);
    if (sitemapUrls.length > 0) {
      discoveredUrls = sitemapUrls;
      discoveryMethod = "sitemap";
    } else {
      // Fallback to nav link extraction
      const navUrls = extractNavLinks(homepageHtml, url);
      if (navUrls.length > 0) {
        discoveredUrls = navUrls;
        discoveryMethod = "nav-links";
      }
    }

    // Step 3: Select top pages
    const selectedPages = scoreAndSelectPages(
      discoveredUrls,
      url,
      options.maxPages
    );

    if (selectedPages.length === 0) {
      return {
        pages: [homepageResult],
        favicon,
        discoveryMethod,
        totalPagesDiscovered: discoveredUrls.length,
        totalPagesScraped: 1,
      };
    }

    // Step 4: Scrape subpages in parallel batches
    const subpageResults = await scrapeInBatches(
      context,
      selectedPages,
      options.pageTimeout,
      options.maxChars
    );

    // Filter out pages with errors or empty markdown
    const successfulSubpages = subpageResults.filter(
      (p) => !p.error && p.markdown.length > 0
    );

    // Deduplicate pages with identical content
    const contentHash = (md: string) =>
      createHash("md5").update(md.trim()).digest("hex");
    const seenHashes = new Set<string>([contentHash(homepageResult.markdown)]);
    const dedupedSubpages = successfulSubpages.filter((page) => {
      const hash = contentHash(page.markdown);
      if (seenHashes.has(hash)) {
        console.log(
          `Dedup: dropping ${page.url} (identical content to earlier page)`
        );
        return false;
      }
      seenHashes.add(hash);
      return true;
    });

    return {
      pages: [homepageResult, ...dedupedSubpages],
      favicon,
      discoveryMethod,
      totalPagesDiscovered: discoveredUrls.length,
      totalPagesScraped: 1 + dedupedSubpages.length,
    };
  } finally {
    if (stealthBrowser) {
      await closeStealthBrowser(stealthBrowser).catch(() => {});
    }
  }
}
