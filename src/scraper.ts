import { createStealthBrowser, closeStealthBrowser } from "./stealth.js";
import { parseHtml, ParsedPage } from "./html-parser.js";
import { installSsrfGuard } from "./ssrf-guard.js";

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
    return parseHtml(rawHtml, url);
  } finally {
    await closeStealthBrowser(stealthBrowser);
  }
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
