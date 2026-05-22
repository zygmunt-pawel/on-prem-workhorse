# Embeddings server — classifier-3090

Standalone embedding service, **separate** from the main `on-prem-workhorse`
stack. Runs **Qwen3-Embedding-8B** (Q8_0 GGUF) on the box `classifier-3090`
(RTX 3090, 24 GB). LAN-only — no Cloudflare tunnel.

- **Host:** `classifier-3090` — LAN IP `192.168.1.138`
- **Endpoint:** `http://192.168.1.138:8091` — OpenAI-compatible `/v1/embeddings`
- **Model:** `Qwen3-Embedding-8B-Q8_0.gguf` — 4096-dim, last-token pooling
- **Why a separate box:** the main stack's RTX 5090 is fully consumed by
  Gemma 31B. This box has a free 24 GB card.

## First-time deploy

1. **Install Docker + NVIDIA toolkit** (one-time, needs sudo):
   ```bash
   sudo bash setup-docker.sh
   ```
   Then log out/in (or `newgrp docker`) so the `docker` group applies.

2. **Download the model** into `./models/`:
   ```bash
   mkdir -p models && curl -L --fail -o models/Qwen3-Embedding-8B-Q8_0.gguf \
     "https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/Qwen3-Embedding-8B-Q8_0.gguf"
   ```

3. **Start:**
   ```bash
   docker compose up -d
   ```

## Manage

```bash
docker compose logs -f        # tail logs
docker compose restart        # restart
docker compose down           # stop
```

## Notes

- Uses the prebuilt `ghcr.io/ggml-org/llama.cpp:server-cuda` image, **not**
  `../Dockerfile` — that one is CUDA 13.0 and this box runs driver 570 (CUDA 12.x).
- `LD_LIBRARY_PATH=/app` in the compose works around an image bug: the build
  ships its `.so` files in `/app` but leaves `/app` off the linker path.
