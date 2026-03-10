import * as cheerio from "cheerio";

/**
 * Extracts navigation links from HTML content.
 * Looks in <nav>, <header>, and [role="navigation"] elements.
 * Returns deduplicated, same-origin URLs.
 */
export function extractNavLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const urls: string[] = [];

  // Select links from navigation-related elements (priority order)
  const primarySelectors = [
    "nav a[href]",
    "header a[href]",
    '[role="navigation"] a[href]',
  ];

  const fallbackSelectors = [
    "footer a[href]",
  ];

  const collect = (selectors: string[]) => {
    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const resolved = resolveUrl(href, baseUrl);
        if (!resolved) return;

        // Filter same-origin only
        if (new URL(resolved).origin !== origin) return;

        // Normalize: remove trailing slash, hash, lowercase
        const normalized = normalizeUrl(resolved);
        if (!normalized) return;

        if (!seen.has(normalized)) {
          seen.add(normalized);
          urls.push(normalized);
        }
      });
    }
  };

  collect(primarySelectors);

  // If primary selectors found very few links, also check footer
  if (urls.length < 5) {
    collect(fallbackSelectors);
  }

  // Last resort: if still very few links, collect all same-origin <a href>
  if (urls.length < 3) {
    collect(["a[href]"]);
  }

  return urls;
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    // Skip anchors, javascript, mailto, tel
    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    ) {
      return null;
    }
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Remove hash
    parsed.hash = "";
    // Remove trailing slash (except for root)
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    parsed.pathname = path;
    return parsed.href;
  } catch {
    return null;
  }
}
