# on-prem-workhorse

Self-hosted inference stack with LAN-only origins. The RTX 5090 LLM is also
published at `https://model.leads.run` through an outbound-only Cloudflare
Tunnel; the scraper remains private to the LAN. The stack provides two
application services:

- **LLM** — Gemma 4 26B-A4B chat completions (OpenAI-compatible API)
- **Scraper** — website → LLM-ready Markdown microservice

Application configuration and API keys live in a local `.env` file on the
host. The tunnel-specific credential is stored separately under
`/home/server/.cloudflared/` and is never committed.

## Architecture

One RTX 5090 GPU box runs the stack. Only the LLM has a public ingress:

```
   Internet clients
          │
   https://model.leads.run
          │
   Cloudflare edge
          │ outbound named tunnel (no router port forwarding)
          ▼
   Host: server (RTX 5090, current DHCP 192.168.1.15) docker compose
   ┌────────────────────────────────────────────────────────────┐
   │  cloudflared          named tunnel → 127.0.0.1:8090        │
   │  ik-llama     :8090   Gemma 4 26B-A4B NVFP4 + MTP (~30 GB VRAM)│
   │  scraper      :3000   Playwright + HTML→Markdown            │
   └────────────────────────────────────────────────────────────┘
```

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

OpenAI-compatible **vLLM 0.29.0** server running NVIDIA's
**Gemma 4 26B-A4B NVFP4** checkpoint with Google's official Gemma 4 assistant
for **MTP speculative decoding**. The server admits up to 80 independent
sequences with at most 32k context each. The LeadsRun client deliberately caps
itself at 64 sequences and 220k conservatively estimated in-flight tokens,
leaving headroom for scheduling and transient MoE workspace. The server uses
FP8 KV cache, CUDA graphs, prefix caching, chunked prefill, asynchronous
scheduling, Model Runner V2, explicit `TRITON_ATTN` attention, and the
`FLASHINFER_CUTLASS` NVFP4 MoE kernel on the RTX 5090.

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
- **Context is dynamic, not eight fixed slots.** The production FP8 KV cache
  measured 8.86 GiB on warm vLLM 0.29/MRV2 benchmark starts. PagedAttention
  shares that pool between as many as 80 shorter sequences. The logged
  147,129-token estimate uses a different async-scheduling calculation than
  0.25; it is not a count of fixed slots or a directly comparable physical capacity. A single sequence
  may use at most 32,768 tokens. The exact pool can vary slightly with the
  driver/compiler build because vLLM profiles CUDA graph memory at startup.
- **The production scheduler uses 8192 batched tokens.** This exact Reddit
  request shape reached roughly 256 prefilter posts in 4.9 seconds while
  keeping 64 sequences active. Larger scheduler batches were slower and 32k
  exhausted transient MoE workspace. Reproducible measurements and rejected
  alternatives are in
  [`benchmarks/reddit-matching/README.md`](benchmarks/reddit-matching/README.md).
- **Transient MoE workspace has explicit headroom.** Production reserves 92% of
  GPU memory for vLLM rather than 94%, and enables PyTorch expandable segments.
  A mixed live wave showed that the FlashInfer fused-MoE kernel can request a
  further 724 MiB even at low KV occupancy; the previous setting could leave only
  495–575 MiB physically free and terminate EngineCore.
  The previous 90% setting was raised to 92% at the operator's request on
  15 September 2026 to increase KV capacity. Configuration instructions are in
  [the memory walkthrough](docs/vllm-pamiec-krok-po-kroku.md).
- **Thinking model.** vLLM 0.29 chat responses expose `reasoning` separately
  from `content` (0.25 used `reasoning_content`). Give a generous `max_tokens` — with a small budget the whole
  allowance can be spent on reasoning and `content` comes back empty.
- **Blackwell FP4.** Weights use NVFP4 and vLLM selects FLASHINFER_CUTLASS on
  SM120. The FlashInfer TRT-LLM MoE kernel and NVFP4 KV path currently reject
  the RTX 5090, so FP8 KV is intentional. The GPU stays below the 450 W power
  limit in measured inference; raising it to 600 W did not improve throughput.
  Install `deploy/systemd/nvidia-power-limit.service` to restore the 450 W cap
  automatically after every reboot.

> **Auto-starts on reboot.** The containers use `restart: unless-stopped` with
> Docker enabled on boot and the model files persisted on disk. After a reboot,
> the stack returns and reloads the model from disk without a manual step.

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

The complete procedure, including the destructive zero-touch Ubuntu USB,
first SSH login, driver installation, Docker/NVIDIA setup, pinned model
downloads, secret provisioning and verification, is the canonical
[`deploy/server/README.md`](deploy/server/README.md) runbook. The exact last
known-good host inventory is in
[`deploy/server/VERIFIED_STATE.md`](deploy/server/VERIFIED_STATE.md).

The USB deliberately installs only a clean, updated Ubuntu system so it stays
reusable on other servers. Once this repository is present on the new host,
the RTX 5090-specific phase is:

```bash
cd /home/server/on-prem-workhorse

# Full Ubuntu updates, NVIDIA 595 open driver, Docker, NVIDIA runtime,
# Hugging Face CLI and persistent 450 W power limit
./deploy/server/bootstrap-host.sh

# Reboot if requested, reconnect, then resume/checksum-verify exact snapshots
./deploy/server/download-models.sh

# Create the local config from the template and fill in the real values
cp .env.example .env
chmod 600 .env
$EDITOR .env

# Build/start the application and optional named tunnel, then test auth,
# inference, health, restart policy, GPU and power cap
./deploy/server/install-stack.sh
./deploy/server/verify.sh
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

Refresh the server source either with Git or with the rsync procedure in the
bare-metal runbook. The current live copy was deployed by rsync and has no
`.git` directory. Then rebuild/reconcile the services:

```bash
docker compose up -d --build
```

The RTX 5090 image pins vLLM to `v0.29.0` and its tested SHA-256 digest.
The Gemma 4 MTP compatibility fix is upstream; no local model patch is applied.
Keep MRV2, Triton attention and FlashInfer CUTLASS MoE when rebuilding.
See the [migration and benchmark conclusions](docs/vllm-029-benchmark.md)
and [full-cache comparison](docs/vllm-kv-pressure-benchmark.md). If the container crashloops after a
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
| `VLLM_MAX_MODEL_LEN` | Maximum context per 5090 sequence; production `32768` |
| `VLLM_MAX_NUM_SEQS` | Server-side sequence ceiling; production `80` |
| `VLLM_MAX_NUM_BATCHED_TOKENS` | Scheduler token budget per iteration; production `8192` |
| `VLLM_GPU_MEMORY_UTILIZATION` | Fraction reserved by vLLM; production `0.92` |
| `VLLM_KV_CACHE_DTYPE` | KV cache format; production `fp8` |
| `VLLM_ATTENTION_BACKEND` | Attention implementation; production `TRITON_ATTN` |
| `VLLM_MOE_BACKEND` | MoE implementation; production `flashinfer_cutlass` |

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
  autoinstall/       # reusable zero-touch Ubuntu Server installer
  server/            # blank-NVMe → verified RTX 5090 production runbook/scripts
  vllm/              # RTX 5090 vLLM 0.29 image + explicit runtime settings
  cloudflared/       # stable public LLM ingress at model.leads.run
  systemd/           # persistent host tuning for the RTX 5090
src/                 # scraper source (TypeScript) — see AGENTS.md
Makefile             # scraper test/dev targets
```
