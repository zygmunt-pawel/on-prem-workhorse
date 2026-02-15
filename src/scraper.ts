import type { BrowserContext } from "playwright-ghost";
import { createStealthBrowser, closeStealthBrowser } from "./stealth.js";
import { parseHtml, ParsedPage } from "./html-parser.js";
import { installSsrfGuard, validateUrlSsrf } from "./ssrf-guard.js";

export interface ScrapeOptions {
  timeout: number;
  proxyUrl?: string;
}

export type ScrapeResult = ParsedPage;

/**
 * Scrapes a page using Playwright with stealth mode enabled.
 * Returns structured JSON with extracted content for LLM analysis.
 */
export async function scrapePage(
  url: string,
  options: ScrapeOptions
): Promise<ScrapeResult> {
  const stealthBrowser = await createStealthBrowser({
    timeout: options.timeout,
    proxyUrl: options.proxyUrl,
  });

  try {
    const { page } = stealthBrowser;
    const ssrf = installSsrfGuard(page);

    // Navigate to page and wait for DOM to be ready
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.timeout,
      });
    } catch (err) {
      if (ssrf.blocked) throw new Error(ssrf.blocked);
      throw err;
    }

    // Wait a bit for JS to render content
    await page.waitForTimeout(2000);

    // Scroll to bottom to trigger lazy-loaded content
    await scrollToBottom(page);

    // Small delay to let any final content render
    await page.waitForTimeout(500);

    // Get the full HTML content
    const rawHtml = await page.content();

    // Parse HTML into structured data
    const result = parseHtml(rawHtml, url);

    // Fetch favicon as base64 data URI
    const dataUri = await fetchFaviconDataUri(
      stealthBrowser.context,
      result.favicon.url,
      url
    );

    return {
      ...result,
      favicon: { url: result.favicon.url, dataUri },
    };
  } finally {
    await closeStealthBrowser(stealthBrowser);
  }
}

// ============ FAVICON FETCHING ============

const FAVICON_TIMEOUT = 5000;

async function tryFetchDataUri(
  context: BrowserContext,
  url: string
): Promise<string | null> {
  try {
    await validateUrlSsrf(url);
    const response = await context.request.get(url, { timeout: FAVICON_TIMEOUT });
    if (!response.ok()) return null;

    const contentType = response.headers()["content-type"] || "image/x-icon";
    const buffer = await response.body();
    if (buffer.length === 0) return null;

    const mimeType = contentType.split(";")[0].trim();
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function fetchFaviconDataUri(
  context: BrowserContext,
  faviconUrl: string | null,
  baseUrl: string
): Promise<string | null> {
  // 1. Try the URL from HTML
  if (faviconUrl) {
    const result = await tryFetchDataUri(context, faviconUrl);
    if (result) return result;
  }

  // 2. Fallback: /favicon.ico
  try {
    const icoUrl = new URL("/favicon.ico", baseUrl).href;
    if (icoUrl !== faviconUrl) {
      const result = await tryFetchDataUri(context, icoUrl);
      if (result) return result;
    }
  } catch {
    // invalid baseUrl
  }

  // 3. Fallback: Google favicon service
  try {
    const domain = new URL(baseUrl).hostname;
    const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    const result = await tryFetchDataUri(context, googleUrl);
    if (result) return result;
  } catch {
    // invalid baseUrl
  }

  return null;
}

/**
 * Scrolls to the bottom of the page to trigger lazy-loaded content.
 */
export async function scrollToBottom(page: import("playwright-ghost").Page): Promise<void> {
  // Using string to avoid tsx/esbuild __name decorator issues with page.evaluate
  await page.evaluate(`(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    let currentPosition = 0;
    const maxScrolls = 50;
    let scrollCount = 0;

    while (currentPosition < scrollHeight && scrollCount < maxScrolls) {
      window.scrollBy(0, viewportHeight);
      currentPosition += viewportHeight;
      scrollCount++;
      await delay(100);

      const newScrollHeight = document.documentElement.scrollHeight;
      if (newScrollHeight > scrollHeight) {
        scrollHeight = newScrollHeight;
      }
    }

    window.scrollTo(0, 0);
  })()`);
}
