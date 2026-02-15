# Favicon Base64 Data URI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Return favicon as `{ url, dataUri }` with actual base64-encoded image data instead of just a URL string.

**Architecture:** html-parser.ts extracts the favicon URL from HTML (as before). scraper.ts and site-crawler.ts use the Playwright browser context to fetch the image, encode as base64 data URI, and return both URL and data URI. Cascading fallback: HTML link tag → /favicon.ico → Google favicon service.

**Tech Stack:** Playwright `context.request.get()` for HTTP fetching, Node.js `Buffer` for base64 encoding.

---

### Task 1: Add Favicon type and update ParsedPage in html-parser.ts

**Files:**
- Modify: `src/html-parser.ts:9-21` (ParsedPage interface)
- Modify: `src/html-parser.ts:660-674` (parseHtml return)

**Step 1: Add Favicon interface and update ParsedPage**

Replace `faviconUrl: string | null` with `favicon` field. Add and export the `Favicon` type.

In `src/html-parser.ts`, change the types section:

```typescript
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
  contentHash: string;
}
```

**Step 2: Update parseHtml() return value**

In the return statement of `parseHtml()` (~line 662), change:

```typescript
// Before:
faviconUrl,
// After:
favicon: { url: faviconUrl, dataUri: null },
```

The local variable `faviconUrl` (from `extractFaviconUrl()`) stays as-is — it still extracts the URL string. We just wrap it in the new structure.

**Step 3: Verify TypeScript compiles**

Run: `cd /Users/pawel/workspace/leads_run_scraper && npx tsc --noEmit`
Expected: Errors in `scraper.ts` and `site-crawler.ts` referencing `faviconUrl` — these will be fixed in subsequent tasks.

**Step 4: Commit**

```bash
git add src/html-parser.ts
git commit -m "refactor: replace faviconUrl with favicon: { url, dataUri } type in ParsedPage"
```

---

### Task 2: Add fetchFaviconDataUri function in scraper.ts

**Files:**
- Modify: `src/scraper.ts` (add new function, update imports)

**Step 1: Add the favicon fetching function**

Add this function after the existing `scrollToBottom` function in `src/scraper.ts`. It takes a Playwright `BrowserContext`, the favicon URL extracted from HTML, and the page's base URL. It tries three sources in cascade:

```typescript
import type { BrowserContext } from "playwright-ghost";

const FAVICON_TIMEOUT = 5000;

async function tryFetchDataUri(
  context: BrowserContext,
  url: string
): Promise<string | null> {
  try {
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
    // Skip if same as faviconUrl (already tried)
    if (icoUrl !== faviconUrl) {
      const result = await tryFetchDataUri(context, icoUrl);
      if (result) return result;
    }
  } catch {
    // invalid baseUrl, skip
  }

  // 3. Fallback: Google favicon service
  try {
    const domain = new URL(baseUrl).hostname;
    const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    const result = await tryFetchDataUri(context, googleUrl);
    if (result) return result;
  } catch {
    // invalid baseUrl, skip
  }

  return null;
}
```

**Step 2: Update scrapePage() to fetch favicon data URI**

In `scrapePage()`, the browser context is available via `stealthBrowser.context`. After `parseHtml()`, fetch the favicon:

```typescript
// Current code:
const rawHtml = await page.content();
return parseHtml(rawHtml, url);

// New code:
const rawHtml = await page.content();
const result = parseHtml(rawHtml, url);

const dataUri = await fetchFaviconDataUri(
  stealthBrowser.context,
  result.favicon.url,
  url
);

return {
  ...result,
  favicon: { url: result.favicon.url, dataUri },
};
```

**Step 3: Verify TypeScript compiles**

Run: `cd /Users/pawel/workspace/leads_run_scraper && npx tsc --noEmit`
Expected: Only errors in `site-crawler.ts` (still references `faviconUrl`).

**Step 4: Commit**

```bash
git add src/scraper.ts
git commit -m "feat: fetch favicon as base64 data URI with cascading fallback"
```

---

### Task 3: Update site-crawler.ts

**Files:**
- Modify: `src/site-crawler.ts:26-39` (PageResult, ScrapeSiteResult types)
- Modify: `src/site-crawler.ts:295-340` (scrapePageInContext)
- Modify: `src/site-crawler.ts:374-498` (scrapeSite main function)

**Step 1: Update types**

In `src/site-crawler.ts`, change `ScrapeSiteResult`:

```typescript
// Before:
export interface ScrapeSiteResult {
  pages: PageResult[];
  faviconUrl: string | null;
  discoveryMethod: "sitemap" | "nav-links" | "homepage-only";
  totalPagesDiscovered: number;
  totalPagesScraped: number;
}

// After:
export interface ScrapeSiteResult {
  pages: PageResult[];
  favicon: Favicon;
  discoveryMethod: "sitemap" | "nav-links" | "homepage-only";
  totalPagesDiscovered: number;
  totalPagesScraped: number;
}
```

Add `Favicon` to the imports from `html-parser.ts`:

```typescript
import { parseHtml, Favicon } from "./html-parser.js";
```

**Step 2: Update scrapePageInContext**

This function currently returns `faviconUrl`. Change to return `favicon`:

```typescript
// In the return type, change:
// Promise<PageResult & { faviconUrl: string | null }>
// to:
// Promise<PageResult & { favicon: Favicon }>

// In the success return:
return {
  url,
  label: "",
  markdown: parsed.markdown,
  favicon: parsed.favicon,
};

// In the error return:
return {
  url,
  label: "",
  markdown: "",
  favicon: { url: null, dataUri: null },
  error: err.message,
};
```

**Step 3: Update scrapeSite main function**

Import `fetchFaviconDataUri` from scraper:

```typescript
import { scrollToBottom, fetchFaviconDataUri } from "./scraper.js";
```

In `scrapeSite()`, after homepage parsing (~line 403), fetch the favicon data URI:

```typescript
// Current:
const faviconUrl = homepageParsed.faviconUrl;

// New:
const faviconDataUri = await fetchFaviconDataUri(
  context,
  homepageParsed.favicon.url,
  url
);
const favicon: Favicon = { url: homepageParsed.favicon.url, dataUri: faviconDataUri };
```

Then update all return statements in scrapeSite() to use `favicon` instead of `faviconUrl`:

```typescript
// Three places where "faviconUrl" appears in returns — change all to "favicon"
// ~line 416 (maxPages <= 0 early return)
// ~line 450 (no selected pages)
// ~line 487 (main return)
```

**Step 4: Verify full TypeScript compile**

Run: `cd /Users/pawel/workspace/leads_run_scraper && npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/site-crawler.ts
git commit -m "feat: update site-crawler to use favicon { url, dataUri } structure"
```

---

### Task 4: Build and smoke test

**Step 1: Full build**

Run: `cd /Users/pawel/workspace/leads_run_scraper && npx tsc`
Expected: Clean compile, `dist/` updated.

**Step 2: Docker build and test**

Run: `cd /Users/pawel/workspace/leads_run_scraper && make rebuild`

Then test with one of the existing targets:

Run: `make test-tembo`

Expected: Response contains `"favicon": { "url": "...", "dataUri": "data:image/...;base64,..." }` instead of `"faviconUrl": "..."`.

**Step 3: Commit build artifacts if needed and push**

```bash
git push origin main
```
