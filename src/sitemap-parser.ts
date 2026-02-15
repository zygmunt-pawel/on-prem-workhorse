import * as cheerio from "cheerio";

const SITEMAP_TIMEOUT = 5000; // 5s timeout for sitemap fetches
const MAX_CHILD_SITEMAPS = 5; // Max child sitemaps to fetch from sitemap index

// Prefer sitemaps with these terms in their URL
const PREFERRED_SITEMAP_TERMS = ["page", "main", "post", "product"];
// Deprioritize sitemaps with these terms
const DEPRIORITIZED_SITEMAP_TERMS = ["blog", "docs", "doc", "tag", "category", "author", "image", "video"];

/**
 * Fetches and parses sitemap.xml to discover page URLs.
 * Handles both regular sitemaps and sitemap indexes.
 * Returns only same-origin URLs.
 */
export async function parseSitemap(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const sitemapUrl = `${origin}/sitemap.xml`;

  try {
    const xml = await fetchText(sitemapUrl);
    if (!xml) return [];

    const $ = cheerio.load(xml, { xmlMode: true });

    // Check if this is a sitemap index
    const sitemapLocs = $("sitemapindex > sitemap > loc");
    if (sitemapLocs.length > 0) {
      return await parseSitemapIndex($, origin);
    }

    // Regular sitemap - extract <loc> URLs
    return extractLocs($, origin);
  } catch {
    return [];
  }
}

async function parseSitemapIndex(
  $: cheerio.CheerioAPI,
  origin: string
): Promise<string[]> {
  const childUrls: string[] = [];
  $("sitemapindex > sitemap > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) childUrls.push(loc);
  });

  // Smart selection: prioritize sitemaps likely to contain page URLs
  const scoredUrls = childUrls.map((url) => {
    const lower = url.toLowerCase();
    let score = 0;
    if (PREFERRED_SITEMAP_TERMS.some((t) => lower.includes(t))) score += 2;
    if (DEPRIORITIZED_SITEMAP_TERMS.some((t) => lower.includes(t))) score -= 2;
    return { url, score };
  });
  scoredUrls.sort((a, b) => b.score - a.score);
  const toFetch = scoredUrls.slice(0, MAX_CHILD_SITEMAPS).map((s) => s.url);
  const results = await Promise.allSettled(
    toFetch.map(async (url) => {
      const xml = await fetchText(url);
      if (!xml) return [];
      const child$ = cheerio.load(xml, { xmlMode: true });
      return extractLocs(child$, origin);
    })
  );

  const allUrls: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allUrls.push(...result.value);
    }
  }
  return allUrls;
}

function extractLocs($: cheerio.CheerioAPI, origin: string): string[] {
  const urls: string[] = [];
  $("urlset > url > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc && isSameOrigin(loc, origin)) {
      urls.push(loc);
    }
  });
  return urls;
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SITEMAP_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SocialWatcher/1.0; +https://socialwatcher.app)",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("xml") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("text/html")
    ) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}
