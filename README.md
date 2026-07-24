# on-prem-workhorse

Self-hosted inference stack with LAN-only origins. The RTX 5090 LLM is also
published at `https://model.leads.run` through an outbound-only Cloudflare
Tunnel; the scraper and RTX 3090 node remain private to the LAN. The stack
provides two application services:

- **LLM** — Gemma 4 26B-A4B chat completions (OpenAI-compatible API)
- **Scraper** — website → LLM-ready Markdown microservice

Application configuration and API keys live in a local `.env` file on the
host. The tunnel-specific credential is stored separately under
`/home/pawel/.cloudflared/` and is never committed.

## Architecture

Two GPU boxes are on the LAN. Only the 5090 LLM has a public ingress:

```
   Internet clients
          │
   https://model.leads.run
          │
   Cloudflare edge
          │ outbound named tunnel (no router port forwarding)
          ▼
   Host: classifier-gpu (RTX 5090, 192.168.1.15)      docker compose
   ┌────────────────────────────────────────────────────────────┐
   │  cloudflared          named tunnel → 127.0.0.1:8090        │
   │  ik-llama     :8090   Gemma 4 26B-A4B NVFP4 + MTP (~30 GB VRAM)│
   │  scraper      :3000   Playwright + HTML→Markdown            │
   └────────────────────────────────────────────────────────────┘

   Host: classifier-3090 (RTX 3090, 192.168.1.138)    docker compose
   ┌────────────────────────────────────────────────────────────┐
   │  ik-llama     :8090   Gemma 4 26B-A4B + MTP   (~18.5 GB VRAM)│
   └────────────────────────────────────────────────────────────┘
                              │
   LAN clients ───────────────┘  same API_KEY → either box, interchangeably
```

The 3090 box is a **second LLM node** running the same 26B-A4B architecture in
GGUF Q4. The 5090 uses native Blackwell NVFP4 kernels and vLLM continuous
batching. Both expose the same OpenAI API and key; clients pick a box by IP.
The 3090 stack lives in `deploy/llm-3090/`.

The application containers are defined in `docker-compose.yml`. The named
tunnel runs from `deploy/cloudflared/docker-compose.yml`; it makes outbound
connections to Cloudflare and requires no inbound router or firewall rule.
Direct host ports remain available on the LAN.

## Services

| Service | Container | Host port | Public route | Auth header |
|---|---|---|---|---|
| LLM | `ik-llama` | 8090 | `https://model.leads.run/v1/*` | `Authorization: Bearer <API_KEY>` |
| Scraper | `scraper` | 3000 | none | `x-api-key: <SCRAPER_API_KEY>` |

`/health` is open on every service (no key) — used by the Docker healthchecks.
All other endpoints require the key. The LLM uses `API_KEY`; the scraper has
its own (`SCRAPER_API_KEY`). The public tunnel allows only `/health` and
`/v1/*`; every other public path returns `404`.

### LLM (5090) — `192.168.1.15:8090`

OpenAI-compatible **vLLM 0.25.0** server running NVIDIA's
**Gemma 4 26B-A4B NVFP4** checkpoint with Google's official Gemma 4 assistant
for **MTP speculative decoding**. It accepts eight concurrent requests with up
to 32k context each, uses FP8 KV cache, CUDA graphs, prefix caching, chunked
prefill, asynchronous scheduling, and the `FLASHINFER_CUTLASS` NVFP4 MoE
kernel selected natively on the RTX 5090.

```bash
curl https://model.leads.run/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-4-26B-A4B-it","messages":[{"role":"user","content":"Hello"}],"max_tokens":200}'
```

LAN clients can use `http://192.168.1.15:8090` directly. Public and LAN clients
use the same bearer key. Endpoints: `/v1/chat/completions`, `/v1/models`,
`/health`.

Notes:
- **MTP uses four speculative tokens.** Matched warm tests measured ~245 tok/s
  for one long response and ~1,435 tok/s aggregate for eight unrelated long
  prompts. Eight constrained-JSON requests reached ~1,811 tok/s. MTP values 1
  through 6 were tested; four was the fastest and most stable general setting.
- **Context is 8 × 32k.** The production FP8 KV cache holds about 289k tokens
  (8.82 theoretical 32k sequences), so eight full request contexts fit. The
  running process reserves about 30.4 of 32.6 GiB VRAM, including the KV pool.
- **Thinking model.** Responses contain a `reasoning_content` field separate
  from `content`. Give a generous `max_tokens` — with a small budget the whole
  allowance can be spent on reasoning and `content` comes back empty.
- **Blackwell FP4.** Weights use NVFP4 and vLLM selects FLASHINFER_CUTLASS on
  SM120. The FlashInfer TRT-LLM MoE kernel and NVFP4 KV path currently reject
  the RTX 5090, so FP8 KV is intentional. The GPU stays below the 450 W power
  limit in measured inference; raising it to 600 W did not improve throughput.

### Second LLM node (3090) — `192.168.1.138:8090`

A second box (`classifier-3090`, RTX 3090, 24 GB) runs the same **Gemma 4
26B-A4B-it** architecture with the smaller Unsloth `UD-Q4_K_XL` quant and MTP.
It uses the same OpenAI API and `API_KEY`; clients pick a box by IP. The Q4
weights fit the 24 GB card, while the 5090 uses the NVFP4 vLLM checkpoint.

```bash
# identical request shape — only the host differs
curl http://192.168.1.138:8090/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":2000}'
```

| | 5090 — `192.168.1.15:8090` | 3090 — `192.168.1.138:8090` |
|---|---|---|
| Model | Gemma 4 26B-**A4B** NVFP4 | Gemma 4 26B-**A4B** GGUF Q4 |
| Gen speed | ~245 tok/s single; ~1,435 aggregate at 8× | ~128–156 tok/s |
| VRAM | ~30.4 / 32.6 GiB (including reserved KV) | ~18.5 / 24 GB |
| Context | 8 × 32k (256k total) | 64k |

Measured on the 3090: generation **128–156 tok/s** (MTP draft accept 53–67%),
prompt processing **~3090 tok/s**. The stack, the box-specific build (CUDA 12.8
for driver 570, native `sm_86`), deploy steps, and reboot behaviour are
documented in **[`deploy/llm-3090/README.md`](deploy/llm-3090/README.md)**.

> **Auto-starts on reboot.** Both LLM boxes use `restart: unless-stopped` with
> Docker enabled on boot and the model files persisted on disk — after a reboot
> the container returns and reloads from disk (no re-download), no manual step.

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
`runtime: nvidia`) and an NVIDIA GPU with enough VRAM (~31 GB including the
preallocated KV pool for this RTX 5090 configuration). The two Gemma repositories
require accepting their Hugging Face terms before downloading.

```bash
git clone git@github.com:zygmunt-pawel/on-prem-workhorse.git
cd on-prem-workhorse

# Create the local config from the template and fill in the real values
cp .env.example .env
$EDITOR .env

# Download the target and official MTP assistant once. Paths must match
# MODEL_DIR/hf in docker-compose.yml.
hf download nvidia/Gemma-4-26B-A4B-NVFP4 \
  --local-dir /home/pawel/models/hf/Gemma-4-26B-A4B-NVFP4
hf download google/gemma-4-26B-A4B-it-assistant \
  --local-dir /home/pawel/models/hf/gemma-4-26B-A4B-it-assistant

# Build images and start everything
docker compose up -d --build
```

`docker compose` reads `.env` automatically. The file is gitignored and is
never committed — it holds the API keys.

The named Cloudflare Tunnel is a separate deployment because its credential is
host-specific. Provision the credential and start it by following
[`deploy/cloudflared/README.md`](deploy/cloudflared/README.md).

The snapshots persist below `MODEL_DIR/hf`; container restarts do not download
them again. vLLM stores compiled CUDA graphs below `VLLM_CACHE_DIR`, making
later starts substantially faster than the first compile. The healthcheck
allows a 180 s start period.

### Updating

```bash
git pull
docker compose up -d --build
```

The RTX 5090 image pins vLLM to `v0.25.0` and applies the small Gemma 4 MTP
embedding-width compatibility patch from `deploy/vllm/`. Update the base image
and revalidate the patch deliberately. If the container crashloops after a
rebuild, check `docker logs ik-llama` first.

## Configuration — `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `API_KEY` | Key for the LLM service (`Bearer` auth) |
| `SCRAPER_API_KEY` | Key for the scraper service (`x-api-key` auth) |
| `PROXY_URL` | Optional HTTP/HTTPS proxy for the scraper's Playwright browser |
| `MODEL_DIR` | Host root containing the two snapshots below `MODEL_DIR/hf` |
| `VLLM_CACHE_DIR` | Persistent vLLM compile/CUDA graph cache directory |

If `SCRAPER_API_KEY` is empty, the scraper registers **no** auth hook and every
endpoint becomes open — keep it set. Same applies to `API_KEY` for the LLM.

Rotating a key: edit `.env`, then `docker compose up -d --force-recreate`.

## Operations

```bash
docker compose ps                 # status of all containers
docker compose logs -f ik-llama   # follow LLM logs (or scraper)
docker compose restart scraper    # restart one service
docker compose down               # stop everything
docker compose -f deploy/cloudflared/docker-compose.yml ps
docker compose -f deploy/cloudflared/docker-compose.yml logs -f cloudflared
```

Quick health check (no key required):

```bash
curl http://192.168.1.15:8090/health
curl http://192.168.1.15:3000/health
curl https://model.leads.run/health
```

## Repository layout

```
docker-compose.yml   # the 2-service stack: scraper, ik-llama
.env.example         # config template — copy to .env and fill in
Dockerfile           # scraper image
deploy/
  vllm/              # RTX 5090 vLLM image + focused Gemma 4 MTP patch
  Dockerfile         # legacy llama.cpp CUDA image used by the 3090 deployment
  entrypoint.sh      # legacy llama.cpp model downloader/launcher
  cloudflared/       # stable public LLM ingress at model.leads.run
  llm-3090/          # compose for the RTX 3090 box: Gemma 4 26B-A4B Q4 + MTP, CUDA 12.8 build
  embeddings-3090/   # legacy embeddings stack for the 3090 (retired — replaced by llm-3090/)
src/                 # scraper source (TypeScript) — see AGENTS.md
Makefile             # scraper test/dev targets
```
