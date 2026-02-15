import Fastify from "fastify";
import { scrapePage, ScrapeResult } from "./scraper.js";
import { scrapeSite, ScrapeSiteResult } from "./site-crawler.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const PROXY_URL = process.env.PROXY_URL || "";

interface ScrapeBody {
  url: string;
  timeout?: number;
}

interface ScraperError {
  message: string;
  code: string;
}

function getErrorCode(error: Error): string {
  const message = error.message.toLowerCase();
  if (message.includes("ssrf") || message.includes("private ip") || message.includes("blocked")) return "SSRF_BLOCKED";
  if (message.includes("timeout")) return "TIMEOUT";
  if (message.includes("net::err_name_not_resolved")) return "DNS_ERROR";
  if (message.includes("net::err_connection_refused")) return "CONNECTION_REFUSED";
  if (message.includes("net::")) return "NETWORK_ERROR";
  if (message.includes("navigation")) return "NAVIGATION_ERROR";
  return "SCRAPE_ERROR";
}

function getHttpStatus(code: string): number {
  switch (code) {
    case "SSRF_BLOCKED":
      return 403;
    case "TIMEOUT":
      return 504;
    case "DNS_ERROR":
    case "CONNECTION_REFUSED":
    case "NETWORK_ERROR":
      return 502;
    case "NAVIGATION_ERROR":
    case "SCRAPE_ERROR":
    case "EMPTY_CONTENT":
      return 422;
    case "INVALID_REQUEST":
    case "INVALID_URL":
      return 400;
    default:
      return 500;
  }
}

const fastify = Fastify({
  logger: true,
});

fastify.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

fastify.post<{ Body: ScrapeBody; Reply: ScrapeResult | ScraperError }>(
  "/scrape",
  {
    schema: {
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          timeout: { type: "number", default: 20000 },
        },
      },
    },
  },
  async (request, reply) => {
    const { url, timeout = 20000 } = request.body;

    if (!url || typeof url !== "string") {
      reply.status(400);
      return { message: "URL is required", code: "INVALID_REQUEST" };
    }

    if (timeout <= 0) {
      reply.status(400);
      return { message: "Timeout must be a positive number", code: "INVALID_REQUEST" };
    }

    try {
      new URL(url);
    } catch {
      reply.status(400);
      return { message: "Invalid URL format", code: "INVALID_URL" };
    }

    try {
      const result = await scrapePage(url, {
        timeout,
        proxyUrl: PROXY_URL || undefined,
      });

      if (!result.markdown.trim()) {
        reply.status(422);
        return { message: "Scraper returned empty markdown", code: "EMPTY_CONTENT" };
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = getErrorCode(err);
      reply.status(getHttpStatus(code));
      return { message: err.message, code };
    }
  }
);

// ============ /scrape-site endpoint ============

interface ScrapeSiteBody {
  url: string;
  timeout?: number;
  pageTimeout?: number;
  maxPages?: number;
}

fastify.post<{ Body: ScrapeSiteBody; Reply: ScrapeSiteResult | ScraperError }>(
  "/scrape-site",
  {
    schema: {
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          timeout: { type: "number", default: 120000 },
          pageTimeout: { type: "number", default: 15000 },
          maxPages: { type: "number", default: 6 },
        },
      },
    },
  },
  async (request, reply) => {
    const {
      url,
      timeout = 120000,
      pageTimeout = 15000,
      maxPages = 6,
    } = request.body;

    if (!url || typeof url !== "string") {
      reply.status(400);
      return { message: "URL is required", code: "INVALID_REQUEST" };
    }

    try {
      new URL(url);
    } catch {
      reply.status(400);
      return { message: "Invalid URL format", code: "INVALID_URL" };
    }

    try {
      const result = await scrapeSite(url, {
        timeout,
        pageTimeout,
        maxPages,
        proxyUrl: PROXY_URL || undefined,
      });

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = getErrorCode(err);
      reply.status(getHttpStatus(code));
      return { message: err.message, code };
    }
  }
);

async function start() {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server listening on port ${PORT}`);
    if (PROXY_URL) {
      console.log(`Proxy enabled: ${PROXY_URL}`);
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
