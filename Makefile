# Scraper testing & management
# Usage: cd scraper && make <target>

SCRAPER_URL ?= http://localhost:3001
COMPOSE := docker compose -f ../docker-compose.yml
FMT := python3 format-output.py --json
WAIT_TIMEOUT ?= 30

.PHONY: help rebuild up logs wait scrape scrape-site

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ─── Service ─────────────────────────────────────────────────────────

rebuild: ## Rebuild from scratch (no cache) and start
	$(COMPOSE) build --no-cache scraper
	$(COMPOSE) up -d scraper
	@$(MAKE) wait

up: ## Build (cached) and start
	$(COMPOSE) build scraper
	$(COMPOSE) up -d scraper
	@$(MAKE) wait

wait: ## Wait for scraper to be healthy (WAIT_TIMEOUT=30)
	@echo "Waiting for scraper (up to $(WAIT_TIMEOUT)s)..."
	@elapsed=0; while [ $$elapsed -lt $(WAIT_TIMEOUT) ]; do \
		if curl -sf $(SCRAPER_URL)/health >/dev/null 2>&1; then \
			echo "Scraper ready ($$elapsed""s)"; \
			exit 0; \
		fi; \
		sleep 1; \
		elapsed=$$((elapsed + 1)); \
	done; \
	echo "ERROR: scraper not ready after $(WAIT_TIMEOUT)s — check: make logs"; \
	exit 1

logs: ## Tail scraper logs
	$(COMPOSE) logs -f --tail=50 scraper

# ─── Test URLs ───────────────────────────────────────────────────────

scrape: ## Single page:  make scrape URL=https://example.com
	@test -n "$(URL)" || (echo "Usage: make scrape URL=https://example.com" && exit 1)
	@curl -s -X POST $(SCRAPER_URL)/scrape \
		-H 'Content-Type: application/json' \
		-d '{"url": "$(URL)", "timeout": 30000}' | $(FMT)

scrape-site: ## Multi-page:   make scrape-site URL=https://example.com
	@test -n "$(URL)" || (echo "Usage: make scrape-site URL=https://example.com" && exit 1)
	@curl -s -X POST $(SCRAPER_URL)/scrape-site \
		-H 'Content-Type: application/json' \
		-d '{"url": "$(URL)", "timeout": 120000, "maxPages": 6}' | $(FMT)

# ─── SSRF integration tests ─────────────────────────────────────────

test-ssrf: up ## Run SSRF protection tests
	@SCRAPER_URL=$(SCRAPER_URL) bash test-ssrf.sh

# ─── Quick tests (auto-build with cache) ────────────────────────────

test-tembo: up ## tembo.io
	@$(MAKE) scrape-site URL=https://www.tembo.io

test-caldo: up ## caldo.pl
	@$(MAKE) scrape-site URL=https://caldo.pl

test-emailit: up ## emailit.com
	@$(MAKE) scrape-site URL=https://emailit.com

test-dealsimu: up ## deal-simulator.com
	@$(MAKE) scrape-site URL=https://www.deal-simulator.com

test-4grosze: up ## 4grosze.pl
	@$(MAKE) scrape-site URL=https://4grosze.pl/en

test-visitors: up ## visitors.now
	@$(MAKE) scrape-site URL=https://visitors.now/home

test-pixelfiddler: up ## pixel-fiddler.com
	@$(MAKE) scrape-site URL=https://pixel-fiddler.com
