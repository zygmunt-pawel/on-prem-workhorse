# Scraper Microservice

Node.js/TypeScript microservice for scraping websites and converting HTML to LLM-ready Markdown. Uses Playwright with stealth plugins to bypass bot detection.

**Stack:** Node.js 22, TypeScript, Fastify 5, Playwright Ghost, Cheerio, Turndown

## Commands

```bash
cd scraper
make rebuild          # Build from scratch (no cache) and start
make up               # Build (cached) and start
make logs             # Tail container logs
make scrape URL=...   # Single page scrape
make scrape-site URL=...  # Multi-page crawl
make test-dealsimu    # Test deal-simulator.com
make test-4grosze     # Test 4grosze.pl
make test-visitors    # Test visitors.now
make test-pixelfiddler # Test pixel-fiddler.com
make test-tembo       # Test tembo.io
make test-caldo       # Test caldo.pl
make test-emailit     # Test emailit.com
```

Docker build & run via parent `docker-compose.local.yml`. Image: `social_watcher_v2_local_scraper`.

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/scrape` | POST | Single page scrape |
| `/scrape-site` | POST | Multi-page site crawl |

**`POST /scrape`** body: `{ url: string, timeout?: number (default 20000) }`

**`POST /scrape-site`** body: `{ url: string, timeout?: number (default 120000), pageTimeout?: number (default 15000), maxPages?: number (default 6) }`

### Response format

Success returns the result object directly (no envelope). Error returns `{ message, code }` with proper HTTP status.

### HTTP status codes

| Error code | HTTP status | Retryable? |
|---|---|---|
| `TIMEOUT` | 504 Gateway Timeout | yes |
| `DNS_ERROR` | 502 Bad Gateway | yes |
| `CONNECTION_REFUSED` | 502 Bad Gateway | yes |
| `NETWORK_ERROR` | 502 Bad Gateway | yes |
| `NAVIGATION_ERROR` | 422 Unprocessable | no |
| `SCRAPE_ERROR` | 422 Unprocessable | no |
| `EMPTY_CONTENT` | 422 Unprocessable | no |
| `INVALID_REQUEST` | 400 Bad Request | no |
| `INVALID_URL` | 400 Bad Request | no |

## Source Files

```
src/
├── server.ts          # Fastify REST API, endpoints, validation
├── scraper.ts         # Single-page scraper (navigate, scroll, extract)
├── site-crawler.ts    # Multi-page orchestrator (discover, score, batch scrape)
├── html-parser.ts     # HTML → Markdown (preprocessing, turndown, postprocessing)
├── sitemap-parser.ts  # /sitemap.xml fetcher & parser
├── nav-extractor.ts   # Navigation link extraction from HTML
└── stealth.ts         # Playwright Ghost browser setup (anti-detection)
```

## Architecture

### Single page (`/scrape`)
`server.ts` → `scraper.ts:scrapePage()` → stealth browser → navigate → wait 2s for JS → scroll to bottom (lazy load) → extract HTML → `html-parser.ts:parseHtml()` → return markdown + metadata

### Multi-page (`/scrape-site`)
`server.ts` → `site-crawler.ts:scrapeSite()`:
1. Scrape homepage (same as single page)
2. Discover subpages: sitemap.xml → nav links → homepage-only fallback
3. Score & select top N pages by priority (features=10, pricing=9, about=8, ...)
4. Skip: blog, docs, login, careers, api, etc.
5. Scrape in batches of 3 concurrent tabs
6. Return all pages with labels + discovery metadata

### HTML → Markdown pipeline (`html-parser.ts`)
1. **Preprocess** — remove scripts, styles, hidden elements, duplicate navs
2. **Carousel dedup** — Jaccard similarity (0.9) removes repeated slides
3. **Section markers** — semantic HTML5 tags → `<!-- SECTION N: tag -->`
4. **List normalization** — inline span sequences → `<ul><li>`
5. **Turndown** — HTML→Markdown with custom rules (strip links, images, buttons)
6. **Postprocess** — collapse blanks, remove empty sections, fix spacing

### Stealth browser (`stealth.ts`)
Playwright Ghost with plugins: `automation`, `webdriver`, `headless`, `screen`, `viewport`, `dialog`, `fingerprint`. Realistic Chrome UA, headers, timezone. Optional proxy via `PROXY_URL` env var.

## Environment Variables

- `PORT` — server port (default: 3000)
- `PROXY_URL` — optional HTTP/HTTPS proxy for Playwright

## Key Constants (site-crawler.ts)

- `CONCURRENCY = 3` — parallel tabs per batch
- Priority map: features(10), pricing(9), about/use-cases/solutions(8), integrations/product/how-it-works(7), customers/testimonials(6), faq/demo(5)
- Skip patterns: blog, docs, changelog, careers, login, signup, dashboard, support, api, status, sitemap, feed
- Max path depth: 3 segments
