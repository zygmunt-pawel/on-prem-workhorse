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

    // Wait for JS to render content and hero animations to complete
    await page.waitForTimeout(3500);

    // Try to dismiss cookie consent banners before screenshot
    await dismissCookieBanner(page);

    // Brief pause for late-appearing modals, then nuke any remaining overlays
    await page.waitForTimeout(500);
    await hideCookieOverlays(page);

    // Nudge scroll: go down ~1 viewport then back to top.
    // This triggers IntersectionObserver-based lazy loading for hero content
    // (e.g. images, canvas, WebGL that only render when scrolled into view).
    await page.evaluate("window.scrollBy(0, window.innerHeight)");
    await page.waitForTimeout(200);
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'instant' })");
    await page.waitForTimeout(300);

    // Capture hero screenshot (viewport as-is, before scroll mutates the page)
    const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 80 });
    const heroScreenshot = `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}`;

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
      heroScreenshot,
    };
  } finally {
    await closeStealthBrowser(stealthBrowser).catch(() => {});
  }
}

// ============ FAVICON FETCHING ============

const FAVICON_TIMEOUT = 5000;
const MAX_FAVICON_SIZE = 1024 * 1024; // 1 MB

async function tryFetchDataUri(
  context: BrowserContext,
  url: string
): Promise<string | null> {
  try {
    await validateUrlSsrf(url);
    const response = await context.request.get(url, { timeout: FAVICON_TIMEOUT });
    if (!response.ok()) return null;

    const contentType = response.headers()["content-type"] || "image/x-icon";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();

    // Only accept image MIME types to prevent XSS via data:text/html URIs
    if (!mimeType.startsWith("image/")) return null;

    const buffer = await response.body();
    if (buffer.length === 0 || buffer.length > MAX_FAVICON_SIZE) return null;

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

// ============ COOKIE BANNER DISMISS ============

const COOKIE_BUTTON_SELECTORS = [
  // Common consent libraries (OneTrust, CookieBot, CookieConsent, Osano, etc.)
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "[data-cky-tag='accept-button']",
  ".cc-accept",
  ".cc-dismiss",
  ".cc-allow",
  ".osano-cm-accept-all",
  // Generic selectors by role/attribute
  "[data-testid='cookie-accept']",
  "[data-action='accept']",
  // Text-based: common accept button labels (EN, PL, DE, FR, ES)
  "button:has-text('Accept All')",
  "button:has-text('Accept all')",
  "button:has-text('Accept')",
  "button:has-text('Allow all')",
  "button:has-text('Allow All')",
  "button:has-text('Agree')",
  "button:has-text('I agree')",
  "button:has-text('Got it')",
  "button:has-text('OK')",
  "button:has-text('Save settings')",
  "button:has-text('Akceptuj')",
  "button:has-text('Zgadzam')",
  "button:has-text('Akzeptieren')",
  "button:has-text('Tout accepter')",
  "button:has-text('Aceptar')",
  "a:has-text('Accept All')",
  "a:has-text('Accept all')",
  "a:has-text('Accept')",
];

async function dismissCookieBanner(page: import("playwright-ghost").Page): Promise<void> {
  // Step 1: Try clicking common accept/dismiss buttons
  for (const selector of COOKIE_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 100 })) {
        await btn.click({ timeout: 400 });
        await page.waitForTimeout(300);
        return;
      }
    } catch {
      // selector not found or not clickable, try next
    }
  }

}

/**
 * Hides any remaining cookie/consent overlays via CSS injection.
 * Catches late-appearing modals, fixed banners, and high-z-index overlays.
 */
async function hideCookieOverlays(page: import("playwright-ghost").Page): Promise<void> {
  await page.evaluate(`(() => {
    const keywords = ['cookie', 'consent', 'gdpr', 'privacy', 'data-collection', 'data collection'];
    function textMatches(el) {
      const text = (el.className + ' ' + el.id + ' ' + (el.textContent || '').substring(0, 300)).toLowerCase();
      return keywords.some(kw => text.includes(kw));
    }
    // Dialogs and known cookie containers
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="overlay"], [id*="cookie"], [id*="consent"], [class*="cookie"], [class*="consent"]').forEach(el => {
      if (textMatches(el)) el.style.display = 'none';
    });
    // Fixed/sticky banners with high z-index
    document.querySelectorAll('div, aside, section').forEach(el => {
      const style = getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'sticky') && parseInt(style.zIndex || '0') > 100) {
        if (textMatches(el)) el.style.display = 'none';
      }
    });
    // Backdrop overlays (semi-transparent or blurred full-screen divs)
    document.querySelectorAll('div').forEach(el => {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' && parseInt(style.zIndex || '0') > 50) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9) {
          el.style.display = 'none';
        }
      }
    });
    // Remove blur/opacity from main content that modals may have applied
    document.querySelectorAll('*').forEach(el => {
      const style = getComputedStyle(el);
      if (style.filter && style.filter !== 'none' && style.filter.includes('blur')) {
        el.style.filter = 'none';
      }
      if (style.backdropFilter && style.backdropFilter !== 'none') {
        el.style.backdropFilter = 'none';
      }
    });
  })()`);
}

// ============ SCROLL ============

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
