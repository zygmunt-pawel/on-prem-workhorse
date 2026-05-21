# on-prem-workhorse

Self-hosted inference stack running on a single GPU machine. Provides three
services behind a Cloudflare tunnel:

- **LLM** — Gemma 4 31B chat completions (OpenAI-compatible API)
- **Embeddings** — gte-Qwen2-7B text embeddings (OpenAI-compatible API)
- **Scraper** — website → LLM-ready Markdown microservice

Fully self-hosted: no cloud dependencies. All configuration and secrets live in
a local `.env` file on the host.

## Architecture

```
                          Cloudflare tunnel (cloudflared container)
                          ┌──────────────────────────────────────┐
  Internet ───────────────┤  model.leads.run      → ik-llama:8090 │
                          │  embeddings.leads.run → embeddings:8091│
                          │  fetch.leads.run      → scraper:3000  │
                          └──────────────────────────────────────┘
                                          │
   Host: classifier-gpu (RTX 5090)        │  docker compose
   ┌────────────────────────────────────────────────────────────┐
   │  ik-llama     :8090   Gemma 4 31B   (GPU, ~30 GB VRAM)       │
   │  embeddings   :8091   gte-Qwen2-7B  (CPU only)               │
   │  scraper      :3000   Playwright + HTML→Markdown             │
   │  cloudflared          outbound tunnel, no inbound ports      │
   └────────────────────────────────────────────────────────────┘
```

Everything runs as Docker containers defined in `docker-compose.yml`. The
machine needs no inbound firewall rules — `cloudflared` makes an outbound-only
connection and Cloudflare routes the three public hostnames to it.

## Services

| Service | Container | Host port | Public URL | Auth header |
|---|---|---|---|---|
| LLM | `ik-llama` | 8090 | `https://model.leads.run` | `Authorization: Bearer <API_KEY>` |
| Embeddings | `embeddings` | 8091 | `https://embeddings.leads.run` | `Authorization: Bearer <API_KEY>` |
| Scraper | `scraper` | 3000 | `https://fetch.leads.run` | `x-api-key: <SCRAPER_API_KEY>` |

`/health` is open on every service (no key) — used by the Docker healthchecks.
All other endpoints require the key. The LLM and embeddings share one key
(`API_KEY`); the scraper has its own (`SCRAPER_API_KEY`).

### LLM — `model.leads.run`

OpenAI-compatible server (`llama.cpp`) running **Gemma 4 31B-it** (Unsloth
`UD-Q6_K_XL` GGUF). All 61 layers offloaded to the GPU, 128k context, single
request slot, flash attention, 4-bit KV cache, n-gram speculative decoding.

```bash
curl https://model.leads.run/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":200}'
```

Endpoints: `/v1/chat/completions`, `/v1/models`, `/health`.

Notes:
- **Thinking model.** Responses contain a `reasoning_content` field separate
  from `content`. Give a generous `max_tokens` — with a small budget the whole
  allowance can be spent on reasoning and `content` comes back empty.
- **Cold start is slow.** The build targets `sm_89` (Ada) PTX; on the RTX 5090
  (Blackwell `sm_120`) CUDA kernels JIT-compile on the first request, which can
  take ~80 s. Subsequent requests run at full speed (~370 tok/s prompt,
  ~46 tok/s generation).

### Embeddings — `embeddings.leads.run`

OpenAI-compatible embeddings server (`llama.cpp`) running
**gte-Qwen2-7B-instruct** (`Q5_K_M` GGUF) on **CPU only**, last-token pooling,
8192 context. Returns 3584-dimensional vectors.

```bash
curl https://embeddings.leads.run/v1/embeddings \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"input":"text to embed"}'
```

Endpoints: `/v1/embeddings`, `/health`.

### Scraper — `fetch.leads.run`

Node.js/TypeScript/Fastify microservice. Scrapes websites with a stealth
Playwright browser and converts the HTML to LLM-ready Markdown. Authenticated
with the `x-api-key` header (not `Bearer`).

```bash
# Single page
curl -X POST https://fetch.leads.run/scrape \
  -H "x-api-key: <SCRAPER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# Multi-page site crawl
curl -X POST https://fetch.leads.run/scrape-site \
  -H "x-api-key: <SCRAPER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":6}'
```

Endpoints: `/scrape`, `/scrape-site`, `/health`. See `AGENTS.md` for the
scraper's request/response schema, error codes, and internals.

## Deployment

### First-time setup on a new machine

Requirements: Docker with the NVIDIA Container Toolkit (the LLM container needs
`runtime: nvidia`), an NVIDIA GPU with enough VRAM (~30 GB for the current
model), and the Cloudflare tunnel token.

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
never committed — it holds the API keys and the Cloudflare tunnel token.

On first start the LLM container downloads the model GGUF from Hugging Face
(`HF_MODEL_URL`) into `MODEL_DIR` if it is not already present. This is a large
download — the container is not healthy until it finishes and the model has
loaded (the healthcheck allows a 300 s start period).

### Updating

```bash
git pull
docker compose up -d --build
```

## Configuration — `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `API_KEY` | Shared key for the LLM and embeddings services (`Bearer` auth) |
| `SCRAPER_API_KEY` | Key for the scraper service (`x-api-key` auth) |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token for the `cloudflared` tunnel |
| `PROXY_URL` | Optional HTTP/HTTPS proxy for the scraper's Playwright browser |
| `HF_MODEL_URL` | Hugging Face URL of the LLM GGUF (downloaded on first run) |
| `MODEL_DIR` | Host directory mounted into the containers as `/models` |

If `SCRAPER_API_KEY` is empty, the scraper registers **no** auth hook and every
endpoint becomes open — keep it set. Same applies to `API_KEY` for the LLM.

Rotating a key: edit `.env`, then `docker compose up -d --force-recreate`.

## Operations

```bash
docker compose ps                 # status of all containers
docker compose logs -f ik-llama   # follow LLM logs (or embeddings / scraper / cloudflared)
docker compose restart scraper    # restart one service
docker compose down               # stop everything
```

Quick health check (no key required):

```bash
curl https://model.leads.run/health
curl https://embeddings.leads.run/health
curl https://fetch.leads.run/health
```

## Repository layout

```
docker-compose.yml   # the 4-service stack: scraper, ik-llama, embeddings, cloudflared
.env.example         # config template — copy to .env and fill in
Dockerfile           # scraper image
deploy/
  Dockerfile         # llama.cpp + CUDA image (used by ik-llama and embeddings)
  entrypoint.sh      # downloads the model GGUF on first run, then starts llama-server
src/                 # scraper source (TypeScript) — see AGENTS.md
Makefile             # scraper test/dev targets
```
