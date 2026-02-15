import { isIPv4, isIPv6 } from "node:net";
import dns from "node:dns/promises";
import type { Page, Route } from "playwright-ghost";

/**
 * Checks if an IP address falls within private/reserved ranges.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 addresses.
 */
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:X.X.X.X) — extract and re-check
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (isIPv4(mapped)) return isPrivateIp(mapped);
  }

  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 127 ||                          // 127.0.0.0/8 loopback
      a === 10 ||                           // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
      (a === 192 && b === 168) ||           // 192.168.0.0/16
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local / cloud metadata
      a === 0                               // 0.0.0.0/8
    );
  }

  if (isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return (
      normalized === "::1" ||               // IPv6 loopback
      normalized === "::" ||                // IPv6 unspecified
      normalized.startsWith("fc") ||        // fc00::/7 (ULA) — fc00-fdff
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")         // fe80::/10 link-local
    );
  }

  return false;
}

export interface SsrfGuard {
  /** Set when a request is blocked — contains the reason. */
  readonly blocked: string | null;
}

/**
 * Installs a route handler on a Playwright page that intercepts ALL requests
 * and blocks those targeting private/reserved IP addresses.
 * Defends against DNS rebinding and redirect-based SSRF.
 *
 * Returns a guard object — check `guard.blocked` after navigation to detect SSRF.
 */
export function installSsrfGuard(page: Page): SsrfGuard {
  const guard = { blocked: null as string | null };

  page.route("**/*", async (route: Route) => {
    const url = route.request().url();

    let hostname: string;
    let scheme: string;
    try {
      const parsed = new URL(url);
      // URL.hostname keeps brackets for IPv6 (e.g. "[::1]") — strip them
      hostname = parsed.hostname.replace(/^\[|\]$/g, "");
      scheme = parsed.protocol.replace(":", "");
    } catch {
      guard.blocked = `SSRF blocked: unparseable URL ${url}`;
      await route.abort("blockedbyclient");
      return;
    }

    // Block non-http(s) schemes (catches file:// via redirect etc.)
    if (scheme !== "http" && scheme !== "https") {
      guard.blocked = `SSRF blocked: non-http scheme "${scheme}" in ${url}`;
      await route.abort("blockedbyclient");
      return;
    }

    // If hostname is a literal IP, check directly
    if (isIPv4(hostname) || isIPv6(hostname)) {
      if (isPrivateIp(hostname)) {
        guard.blocked = `SSRF blocked: private IP ${hostname} in ${url}`;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
      return;
    }

    // Resolve domain and check all addresses
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      for (const entry of addresses) {
        if (isPrivateIp(entry.address)) {
          guard.blocked = `SSRF blocked: ${hostname} resolved to private IP ${entry.address}`;
          await route.abort("blockedbyclient");
          return;
        }
      }
    } catch {
      // Fail-closed: if Node.js DNS can't resolve, block the request.
      // Chromium uses a separate resolver and may resolve to a private IP
      // that we can't validate here (TOCTOU / dual-resolver SSRF bypass).
      guard.blocked = `SSRF blocked: DNS resolution failed for ${hostname} in ${url}`;
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });

  return guard;
}
