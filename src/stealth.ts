import { chromium } from "playwright-ghost";
import plugins from "playwright-ghost/plugins";
import type { Browser, BrowserContext, Page } from "playwright-ghost";

export interface StealthBrowserOptions {
  timeout: number;
  proxyUrl?: string;
}

export interface StealthBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function createStealthBrowser(
  options: StealthBrowserOptions
): Promise<StealthBrowser> {
  const launchOptions: Record<string, unknown> = {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };

  if (options.proxyUrl) {
    launchOptions.proxy = { server: options.proxyUrl };
  }

  const browser = await chromium.launch({
    ...launchOptions,
    plugins: [
      // Polyfill plugins - hide automation signals
      plugins.polyfill.automation(),
      plugins.polyfill.webdriver(),
      plugins.polyfill.headless(),
      plugins.polyfill.screen({ width: 1920, height: 1080 }),
      plugins.polyfill.viewport({
        width: { min: 1200, max: 1600 },
        height: { min: 700, max: 900 },
      }),

      // Humanize plugins - make interactions more realistic
      plugins.humanize.dialog(),

      // Fingerprint randomization
      await plugins.utils.fingerprint({
        fingerprintOptions: {
          browsers: ["chrome"],
          operatingSystems: ["windows", "macos"],
          devices: ["desktop"],
        },
      }),
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  context.setDefaultTimeout(options.timeout);
  context.setDefaultNavigationTimeout(options.timeout);

  const page = await context.newPage();

  return { browser, context, page };
}

export async function closeStealthBrowser(
  stealthBrowser: StealthBrowser
): Promise<void> {
  await stealthBrowser.context.close();
  await stealthBrowser.browser.close();
}
