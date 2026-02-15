#!/usr/bin/env bash
# Integration tests for SSRF protection.
# Requires the scraper container to be running (started by `make test-ssrf`).

set -euo pipefail

SCRAPER_URL="${SCRAPER_URL:-http://localhost:3000}"
PASSED=0
FAILED=0

# ── Helpers ──────────────────────────────────────────────────────────

scrape() {
  local url="$1"
  curl -s -w "\n%{http_code}" -X POST "$SCRAPER_URL/scrape" \
    -H 'Content-Type: application/json' \
    -d "{\"url\": \"$url\", \"timeout\": 15000}"
}

assert_blocked() {
  local label="$1" url="$2"
  local response http_code body code

  response=$(scrape "$url")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')
  code=$(echo "$body" | grep -o '"code":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [[ "$http_code" == "403" && "$code" == "SSRF_BLOCKED" ]]; then
    echo "  PASS  $label → 403 SSRF_BLOCKED"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL  $label → expected 403/SSRF_BLOCKED, got $http_code/$code"
    echo "        body: $body"
    FAILED=$((FAILED + 1))
  fi
}

assert_ok() {
  local label="$1" url="$2"
  local response http_code

  response=$(scrape "$url")
  http_code=$(echo "$response" | tail -1)

  if [[ "$http_code" == "200" ]]; then
    echo "  PASS  $label → 200 OK"
    PASSED=$((PASSED + 1))
  else
    local body
    body=$(echo "$response" | sed '$d')
    echo "  FAIL  $label → expected 200, got $http_code"
    echo "        body: $(echo "$body" | head -c 200)"
    FAILED=$((FAILED + 1))
  fi
}

# ── Tests ────────────────────────────────────────────────────────────

echo "SSRF Protection Tests"
echo "====================="
echo ""

echo "── Literal private IPs ──"
assert_blocked "Loopback (127.0.0.1)"              "http://127.0.0.1/"
assert_blocked "Loopback alt (127.0.0.2)"          "http://127.0.0.2/"
assert_blocked "Private 10.x (10.0.0.1)"           "http://10.0.0.1/"
assert_blocked "Private 172.16.x (172.16.0.1)"     "http://172.16.0.1/"
assert_blocked "Private 192.168.x (192.168.1.1)"   "http://192.168.1.1/"
assert_blocked "Cloud metadata (169.254.169.254)"   "http://169.254.169.254/latest/meta-data/"
assert_blocked "Zero IP (0.0.0.0)"                  "http://0.0.0.0/"
assert_blocked "IPv6 loopback (::1)"                "http://[::1]/"

echo ""
echo "── DNS rebinding ──"
assert_blocked "localtest.me (→ 127.0.0.1)"        "http://localtest.me/"
assert_blocked "nip.io (127.0.0.1.nip.io)"         "http://127.0.0.1.nip.io/"
assert_blocked "nip.io 10.x (10.0.0.1.nip.io)"     "http://10.0.0.1.nip.io/"

echo ""
echo "── DNS resolution failure (fail-closed) ──"
assert_blocked "Non-existent domain"                "http://this-domain-does-not-exist-xxxx9999.com/"
assert_blocked "Non-existent subdomain"             "http://nxdomain.example.invalid/"

echo ""
echo "── Scheme bypass ──"
assert_blocked "file:// scheme"                     "file:///etc/passwd"

echo ""
echo "── Allowed requests (should be 200) ──"
assert_ok "Public site (example.com)" "https://example.com"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "─────────────────────"
echo "Passed: $PASSED  Failed: $FAILED"

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
