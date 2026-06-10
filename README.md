# on-prem-workhorse

Self-hosted inference stack running on a single GPU machine, **LAN-only by
design** — no tunnel, no public exposure, no cloud dependencies. Provides two
services:

- **LLM** — Gemma 4 31B chat completions (OpenAI-compatible API)
- **Scraper** — website → LLM-ready Markdown microservice

All configuration and secrets live in a local `.env` file on the host.

## Architecture

```
   Host: classifier-gpu (RTX 5090, 192.168.1.15)      docker compose
   ┌────────────────────────────────────────────────────────────┐
   │  ik-llama     :8090   Gemma 4 31B + MTP  (GPU, ~30 GB VRAM) │
   │  scraper      :3000   Playwright + HTML→Markdown            │
   └────────────────────────────────────────────────────────────┘
                              │
   LAN clients ───────────────┘  http://192.168.1.15:{8090,3000}
```

Everything runs as Docker containers defined in `docker-compose.yml`. Both
ports are published on the host's LAN address only — nothing is reachable from
the internet.

## Services

| Service | Container | Host port | Auth header |
|---|---|---|---|
| LLM | `ik-llama` | 8090 | `Authorization: Bearer <API_KEY>` |
| Scraper | `scraper` | 3000 | `x-api-key: <SCRAPER_API_KEY>` |

`/health` is open on every service (no key) — used by the Docker healthchecks.
All other endpoints require the key. The LLM uses `API_KEY`; the scraper has
its own (`SCRAPER_API_KEY`).

### LLM — `:8090`

OpenAI-compatible server (`llama.cpp`) running **Gemma 4 31B-it** (Unsloth
`UD-Q6_K_XL` GGUF). All layers offloaded to the GPU, 64k context, single
request slot, flash attention, 4-bit KV cache, **MTP speculative decoding**
(a dedicated draft head trained with the model — `-md` flag).

```bash
curl http://192.168.1.15:8090/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":200}'
```

Endpoints: `/v1/chat/completions`, `/v1/models`, `/health`.

Notes:
- **MTP speculative decoding** gives a measured 2–2.3× generation speedup over
  the previous n-gram setup (~86–125 tok/s vs ~45–54, biggest gain on
  structured/JSON output) at identical quality — the main model verifies every
  draft token, so output is bit-equivalent to running without it. Requires
  llama.cpp master ≥ 2026-06-07 (Gemma4 MTP support).
- **Context is 64k, not 128k.** The Q6 weights + 128k KV cache + MTP draft do
  not fit in 32 GB VRAM together; halving the context frees the ~2.5 GB the
  draft needs. If you need 128k back, switch to the `UD-Q5_K_XL` GGUF (same
  measured speed, one quant level lower) or drop the `-md`/`--spec-type` args.
- **Thinking model.** Responses contain a `reasoning_content` field separate
  from `content`. Give a generous `max_tokens` — with a small budget the whole
  allowance can be spent on reasoning and `content` comes back empty.
- **Cold start is slow.** The build targets `sm_89` (Ada) PTX; on the RTX 5090
  (Blackwell `sm_120`) CUDA kernels JIT-compile on the first request, which can
  take ~80 s. Subsequent requests run at full speed.

### Scraper — `:3000`

Node.js/TypeScript/Fastify microservice. Scrapes websites with a stealth
Playwright browser and converts the HTML to LLM-ready Markdown. Authenticated
with the `x-api-key` header (not `Bearer`).

```bash
# Single page
curl -X POST http://192.168.1.15:3000/scrape \
  -H "x-api-key: <SCRAPER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# Multi-page site crawl
curl -X POST http://192.168.1.15:3000/scrape-site \
  -H "x-api-key: <SCRAPER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":6}'
```

Endpoints: `/scrape`, `/scrape-site`, `/health`. See `AGENTS.md` for the
scraper's request/response schema, error codes, and internals.

## Deployment

### First-time setup on a new machine

Requirements: Docker with the NVIDIA Container Toolkit (the LLM container needs
`runtime: nvidia`) and an NVIDIA GPU with enough VRAM (~30 GB for the current
model + draft + 64k KV cache).

```bash
git clone git@github.com:zygmunt-pawel/on-prem-workhorse.git
cd on-prem-workhorse

# Create the local config from the template and fill in the real values
cp .env.example .env
$EDITOR .env

# Build images and start everything
docker compose up -d --build
```

`docker compose` reads `.env` automatically. The file is gitignored and is
never committed — it holds the API keys.

On first start the LLM container downloads the model GGUF and the MTP draft
GGUF from Hugging Face (`HF_MODEL_URL`, `HF_DRAFT_URL`) into `MODEL_DIR` if not
already present. The main model is a large download — the container is not
healthy until it finishes and the model has loaded (the healthcheck allows a
300 s start period).

### Updating

```bash
git pull
docker compose up -d --build
```

The llama.cpp image builds from current `master` at build time — after a long
gap, expect upstream flag renames (e.g. `--draft-max`/`--draft-min` were
removed in mid-2026 in favour of `--spec-*`). If the container crashloops after
a rebuild, check `docker logs ik-llama` for argument errors first.

## Configuration — `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `API_KEY` | Key for the LLM service (`Bearer` auth) |
| `SCRAPER_API_KEY` | Key for the scraper service (`x-api-key` auth) |
| `PROXY_URL` | Optional HTTP/HTTPS proxy for the scraper's Playwright browser |
| `HF_MODEL_URL` | Hugging Face URL of the LLM GGUF (downloaded on first run) |
| `HF_DRAFT_URL` | Hugging Face URL of the MTP draft GGUF (downloaded on first run) |
| `MODEL_DIR` | Host directory mounted into the containers as `/models` |

If `SCRAPER_API_KEY` is empty, the scraper registers **no** auth hook and every
endpoint becomes open — keep it set. Same applies to `API_KEY` for the LLM.

Rotating a key: edit `.env`, then `docker compose up -d --force-recreate`.

## Operations

```bash
docker compose ps                 # status of all containers
docker compose logs -f ik-llama   # follow LLM logs (or scraper)
docker compose restart scraper    # restart one service
docker compose down               # stop everything
```

Quick health check (no key required):

```bash
curl http://192.168.1.15:8090/health
curl http://192.168.1.15:3000/health
```

## Repository layout

```
docker-compose.yml   # the 2-service stack: scraper, ik-llama
.env.example         # config template — copy to .env and fill in
Dockerfile           # scraper image
deploy/
  Dockerfile         # llama.cpp + CUDA image (used by ik-llama)
  entrypoint.sh      # downloads model + MTP draft GGUFs on first run, then starts llama-server
  embeddings-3090/   # compose for the separate embeddings box (RTX 3090)
src/                 # scraper source (TypeScript) — see AGENTS.md
Makefile             # scraper test/dev targets
```
