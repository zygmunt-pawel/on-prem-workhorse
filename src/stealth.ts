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

// ============ CHROME FLAGS ============

// Base stealth flags — hide automation signals and harden fingerprint
const STEALTH_ARGS = [
  // Core anti-detection
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",

  // Pointer/hover type spoofing — appear as a real desktop with mouse
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",

  // Disable features that leak automation context
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--disable-translate",

  // Performance & network
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--enable-tcp-fast-open",
  "--enable-async-dns",
  "--metrics-recording-only",
  "--no-pings",

  // Disable service workers (reduces fingerprint surface, speeds up loads)
  "--disable-service-worker-web-accessibility",
];

// Extra flags when using proxy — prevent IP leaks
const PROXY_ARGS = [
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--enforce-webrtc-ip-permission-check",
  "--disable-webrtc-hw-encoding",
  "--disable-webrtc-hw-decoding",
];

// ============ RESOURCE BLOCKING ============

/** Block heavy resources we don't need — speeds up scraping significantly */
const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
]);

/** Allow critical domains even for blocked resource types (e.g. fonts needed for layout) */
const RESOURCE_BLOCK_BYPASS = /favicon|google\.com\/s2\/favicons/i;

export async function setupResourceBlocking(context: BrowserContext): Promise<void> {
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();

    if (BLOCKED_RESOURCE_TYPES.has(type) && !RESOURCE_BLOCK_BYPASS.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
}

// ============ CANVAS NOISE INJECTION ============

/** Inject subtle noise into canvas to defeat canvas fingerprinting */
const CANVAS_NOISE_SCRIPT = `(() => {
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const noise = () => (Math.random() - 0.5) * 2;

  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imageData = origGetImageData.call(ctx, 0, 0, 1, 1);
        imageData.data[0] = Math.max(0, Math.min(255, imageData.data[0] + noise()));
        ctx.putImageData(imageData, 0, 0);
      }
    } catch {}
    return origToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function(...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imageData = origGetImageData.call(ctx, 0, 0, 1, 1);
        imageData.data[0] = Math.max(0, Math.min(255, imageData.data[0] + noise()));
        ctx.putImageData(imageData, 0, 0);
      }
    } catch {}
    return origToBlob.apply(this, args);
  };
})()`;

// ============ BROWSER CREATION ============

export async function createStealthBrowser(
  options: StealthBrowserOptions
): Promise<StealthBrowser> {
  const args = [...STEALTH_ARGS];
  if (options.proxyUrl) {
    args.push(...PROXY_ARGS);
  }

  const launchOptions: Record<string, unknown> = {
    headless: true,
    args,
  };

  if (options.proxyUrl) {
    launchOptions.proxy = { server: options.proxyUrl };
  }

  const browser = await chromium.launch({
    ...launchOptions,
    plugins: [
      // Polyfill plugins — hide automation signals
      plugins.polyfill.automation(),
      plugins.polyfill.webdriver(),
      plugins.polyfill.headless(),
      plugins.polyfill.screen({ width: 1920, height: 1080 }),
      plugins.polyfill.viewport({
        width: { min: 1200, max: 1600 },
        height: { min: 700, max: 900 },
      }),

      // Humanize plugins — make interactions more realistic
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

  try {
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
        // Appear as organic search traffic
        "Referer": "https://www.google.com/",
      },
    });

    context.setDefaultTimeout(options.timeout);
    context.setDefaultNavigationTimeout(options.timeout);

    // Inject canvas noise on every new page to defeat canvas fingerprinting
    await context.addInitScript(CANVAS_NOISE_SCRIPT);

    const page = await context.newPage();

    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

export async function closeStealthBrowser(
  stealthBrowser: StealthBrowser
): Promise<void> {
  try { await stealthBrowser.context.close(); } catch { /* already dead */ }
  try { await stealthBrowser.browser.close(); } catch { /* already dead */ }
}
