# LLM server — classifier-3090

Standalone LLM service, **separate** from the main `on-prem-workhorse` stack.
Runs **Gemma 4 26B-A4B-it** (Unsloth `UD-Q4_K_XL` GGUF) + **MTP speculative
decoding** via upstream `llama.cpp` on the box `classifier-3090` (RTX 3090,
24 GB). LAN-only — no tunnel. This box previously ran the embeddings server
(`../embeddings-3090/`); that stack is retired in favour of this one.

- **Host:** `classifier-3090` — LAN IP `192.168.1.138`
- **Endpoint:** `http://192.168.1.138:8090` — OpenAI-compatible `/v1/chat/completions`
- **Model:** `gemma-4-26B-A4B-it` — 26B MoE, **4B active**, Q4_K_XL, 64k context
- **Auth:** `Authorization: Bearer <API_KEY>`

## Why A4B Q4 (not the 5090's 31B dense Q6)

The 5090 serves `gemma-4-31B-it` dense at Q6 + MTP + 64k ≈ **30 GB** — that does
not fit in a 24 GB 3090. The 26B **MoE** has only **4B active params**, so it is
fast even here, with quality close to the 31B dense. At Q4_K_XL it fits with the
same flags and the same 64k context:

| Component | VRAM |
|---|---|
| Weights — A4B `UD-Q4_K_XL` | ~17.0 GB |
| MTP draft — `F16-MTP` | ~0.85 GB |
| KV cache — 64k @ `q4_0` + compute buffers | ~2.5–3.5 GB |
| **Total** | **~21 GB / 24 GB** |

## No OOM-after-hours — VRAM is bounded by design

Same flags as the 5090. The VRAM ceiling is fixed **at load**, it does not grow:

- `-c 65536` — the KV cache is **pre-allocated** to the full 64k up front. It
  occupies its maximum from the first second; it never grows with traffic.
- `-np 1` — a single slot, so one context's worth of KV, not one per client.
- `-ctk q4_0 / -ctv q4_0` — 4-bit KV, ~4× smaller than `q8_0`.
- `-fa 1` — flash attention (required for quantized KV).

So once the container is healthy, the ~21 GB figure is the steady-state ceiling.
There is no runaway prompt/KV cache to OOM the box later.

## Build pins for this box (differ from the 5090)

These are set in `docker-compose.yml` / `deploy/Dockerfile`, no manual action:

- **`CUDA_TAG=12.8.0`** — driver `570.195.03` caps at CUDA 12.8. The default
  CUDA **13.0** image fails to initialise here; the build overrides it to 12.8.
- **`CUDA_ARCH=86`** — native Ampere (`sm_86`), so no first-request JIT compile
  (the 5090's ~80 s cold start was Blackwell JIT; this box warms up faster).
- **`runtime: nvidia`** — `--gpus all` does **not** attach the GPU on this box.
- **Do not add `--no-mmap`** — only ~15 GB system RAM; forcing the 17 GB model
  into host RAM would OOM the host. Default mmap streams the weights to VRAM.

## First-time deploy

1. **Install Docker + NVIDIA toolkit** (one-time, needs sudo) — reuse the
   embeddings box script:
   ```bash
   sudo bash ../embeddings-3090/setup-docker.sh
   ```
   Then log out/in (or `newgrp docker`).

2. **Retire the embeddings stack** (frees the GPU):
   ```bash
   cd ../embeddings-3090 && docker compose down && cd -
   ```

3. **Get the GGUFs onto the box** — preferred: copy from the 5090, where they
   already exist (avoids a 17 GB HF re-download). From the 5090 host:
   ```bash
   rsync -av --progress \
     /home/pawel/models/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf \
     /home/pawel/models/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-F16-MTP.gguf \
     classifier-3090:/home/pawel/models/gemma-4-26B-A4B-it-GGUF/
   ```
   Otherwise leave them missing and `entrypoint.sh` will download from the
   `HF_*_URL` in `.env` on first start (verify those URLs first — see below).

4. **Config + start:**
   ```bash
   cp .env.example .env && $EDITOR .env   # set API_KEY (match the 5090 to share clients)
   docker compose up -d --build
   ```
   First build compiles llama.cpp (a few minutes). The container is not healthy
   until the model loads (healthcheck allows a 180 s start period).

## Verify after start

```bash
docker logs -f ik-llama                 # watch model load / warmup
curl http://192.168.1.138:8090/health   # no key required
curl http://192.168.1.138:8090/v1/models -H "Authorization: Bearer <API_KEY>"
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader  # expect ~21 GB
```

Smoke test a completion:
```bash
curl http://192.168.1.138:8090/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":200}'
```

## Notes

- **HF download URLs are by-analogy guesses** (the Unsloth A4B repo, mirroring
  the 31B repo layout). The reliable path is the `rsync` in step 3 from the 5090,
  where both files are confirmed present. Verify the URLs before depending on them.
- **Thinking model.** Responses carry a `reasoning_content` field separate from
  `content`. Give a generous `max_tokens` or `content` can come back empty.
- **If VRAM is tighter than expected** (KV larger on this arch), drop to a 48k or
  32k context (`-c 49152` / `-c 32768`) before touching the quant — A4B Q4 quality
  is the floor worth keeping.

## Survives reboot — no manual restart needed

The service comes back **automatically** after a host reboot:

- Docker is enabled on boot (`systemctl is-enabled docker` → `enabled`).
- The container uses `restart: unless-stopped`, so the daemon brings it back on
  startup unless it was explicitly `docker compose down`-ed.
- Both GGUFs persist under `MODEL_DIR`, so there is **no re-download** — the
  server just reloads from disk and warms up (native `sm_86`, no JIT → quick).

So after a power cut or reboot: daemon starts → container restarts → model loads
from disk → `healthy`, with zero intervention. (If you ever `docker compose
down` it, it stays down until the next `up` — that is the "unless-stopped" part.)

## Manage

```bash
docker compose logs -f        # tail logs
docker compose restart        # restart
docker compose down           # stop (stays down across reboots until you 'up')
docker compose up -d --build  # rebuild + start (after editing the stack)
```
