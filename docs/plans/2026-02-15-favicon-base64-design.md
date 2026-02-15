# Favicon as Base64 Data URI

## Goal

Return favicon as `favicon: { url, dataUri }` instead of `faviconUrl: string` in both `/scrape` and `/scrape-site` responses. Fetch the actual image during scraping and encode as base64 data URI.

## Structure

```typescript
interface Favicon {
  url: string | null;
  dataUri: string | null; // "data:image/png;base64,iVBOR..."
}
```

Always return the full structure. `dataUri` is `null` only if all fetch attempts fail.

## Fetch Strategy (aggressive, cascading)

1. URL extracted from HTML (`<link rel="icon">`, `shortcut icon`, `apple-touch-icon`)
2. Fallback: `{origin}/favicon.ico`
3. Fallback: `https://www.google.com/s2/favicons?domain={domain}&sz=64`

Each step tried only if previous failed. Per-attempt timeout: 5s. Use `context.request.get()` (Playwright browser context) to go through same proxy/stealth.

## File Changes

| File | Change |
|------|--------|
| `html-parser.ts` | `ParsedPage.faviconUrl` → `ParsedPage.favicon: Favicon` (dataUri always null here) |
| `scraper.ts` | Add `fetchFaviconDataUri(context, faviconUrl, baseUrl)`. Call after `parseHtml()`, set `favicon.dataUri` |
| `site-crawler.ts` | `ScrapeSiteResult.faviconUrl` → `favicon: Favicon`. Fetch favicon for homepage only |

## Error Handling

Favicon fetch failures never break the scrape. On failure: `{ url: <extracted-url-or-null>, dataUri: null }`.
