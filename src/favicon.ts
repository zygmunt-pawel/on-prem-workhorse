import * as cheerio from "cheerio";
import { validateUrlSsrf } from "./ssrf-guard.js";
import type { Favicon } from "./html-parser.js";

const FAVICON_TIMEOUT = 5000;
const MAX_FAVICON_SIZE = 1024 * 1024; // 1 MB
const MAX_HTML_HEAD_SIZE = 256 * 1024; // 256 KB — only need <head> for link tags

/**
 * Tries to fetch a URL and return its content as a base64 data URI.
 * Returns null on any failure. Enforces size limit and image MIME type.
 */
async function tryFetchDataUri(url: string): Promise<string | null> {
  try {
    await validateUrlSsrf(url);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FAVICON_TIMEOUT),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) return null;

    // Reject responses that declare a size exceeding our limit
    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_FAVICON_SIZE) return null;

    const contentType = response.headers.get("content-type") || "image/x-icon";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();

    // Only accept image MIME types to prevent XSS via data:text/html URIs
    if (!mimeType.startsWith("image/")) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_FAVICON_SIZE) return null;

    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Extracts favicon URL from HTML <link> tags.
 */
function extractFaviconUrlFromHtml(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const selectors = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
  ];

  for (const selector of selectors) {
    const href = $(selector).attr("href");
    if (href) {
      try {
        return new URL(href, baseUrl).href;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Lightweight favicon fetcher — no Playwright, plain Node fetch.
 * Cascading strategy:
 *   1. /favicon.ico (most common, fastest)
 *   2. Fetch HTML <head>, parse <link rel="icon">
 *   3. Google favicon service
 */
export async function fetchFavicon(inputUrl: string): Promise<Favicon> {
  let origin: string;
  let domain: string;
  try {
    const parsed = new URL(inputUrl);
    origin = parsed.origin;
    domain = parsed.hostname;
  } catch {
    return { url: null, dataUri: null };
  }

  // 1. Try /favicon.ico directly
  const icoUrl = `${origin}/favicon.ico`;
  const icoResult = await tryFetchDataUri(icoUrl);
  if (icoResult) {
    return { url: icoUrl, dataUri: icoResult };
  }

  // 2. Fetch page HTML head, extract <link rel="icon">
  let htmlFaviconUrl: string | null = null;
  try {
    await validateUrlSsrf(inputUrl);
    const response = await fetch(inputUrl, {
      signal: AbortSignal.timeout(FAVICON_TIMEOUT),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (response.ok) {
      const htmlContentLength = parseInt(response.headers.get("content-length") || "0", 10);
      if (htmlContentLength > MAX_HTML_HEAD_SIZE) {
        // Skip parsing — page too large, we only need <head>
      } else {
        const html = await response.text();
        htmlFaviconUrl = extractFaviconUrlFromHtml(html.slice(0, MAX_HTML_HEAD_SIZE), inputUrl);
      }
      if (htmlFaviconUrl) {
        const dataUri = await tryFetchDataUri(htmlFaviconUrl);
        if (dataUri) {
          return { url: htmlFaviconUrl, dataUri };
        }
      }
    }
  } catch {
    // continue to fallback
  }

  // 3. Fallback: Google favicon service
  const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  const googleResult = await tryFetchDataUri(googleUrl);
  if (googleResult) {
    return { url: htmlFaviconUrl ?? icoUrl, dataUri: googleResult };
  }

  return { url: htmlFaviconUrl ?? icoUrl, dataUri: null };
}
