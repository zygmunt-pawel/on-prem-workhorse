# Embeddings server — classifier-3090

Standalone embedding service, **separate** from the main `on-prem-workhorse`
stack. Runs **Qwen3-Embedding-4B** via **TEI** (HuggingFace Text Embeddings
Inference) on the box `classifier-3090` (RTX 3090, 24 GB). LAN-only — no
Cloudflare tunnel.

- **Host:** `classifier-3090` — LAN IP `192.168.1.138`
- **Endpoint:** `http://192.168.1.138:8091` — OpenAI-compatible `/v1/embeddings`
- **Model:** `Qwen/Qwen3-Embedding-4B` — **2560-dim**, last-token pooling, FP16
- **Engine:** TEI `86-1.8` with dynamic batching → ~7.2k tok/s sustained
  (GPU saturates around ~32 concurrent requests; up to 512 accepted). The old
  single-slot llama.cpp 8B did ~2k tok/s.
- **Why a separate box:** the main stack's RTX 5090 is fully consumed by
  Gemma 31B. This box has a free 24 GB card.

> **Vector space note:** 4B vectors are **2560-dim** and live in a different
> space than the old 8B (4096-dim). Embeddings from the two models are **not
> comparable** — switching models means re-embedding the whole corpus.

## Usage

OpenAI-compatible embeddings API. No auth — reachable by any host on the LAN.

### Single text

```bash
curl http://192.168.1.138:8091/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"input": "I froze when the client asked about the price"}'
```

### Batch — many texts in one request (preferred)

```bash
curl http://192.168.1.138:8091/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"input": ["first text", "second text", "third text"]}'
```

Response: `{"data": [{"embedding": [...2560 floats...], "index": 0}, ...]}` —
embeddings come back in input order. The server splits oversized batches
internally, so one request can carry hundreds of short texts.

### Problem↔solution matching (the actual use case)

Qwen3-Embedding is **asymmetric**: the *query* side takes a task instruction,
the *document* side stays raw. To match a product against customer pain
points, the **product is the query**, the **posts are documents**.

**Product** — prepend the instruction, send the whole string as `input`:

```
Instruct: Given a product description, retrieve customer complaints and pain points that this product would solve.
Query: <product description>
```

**Posts** — send raw, no instruction.

Then compute cosine similarity between the product vector and each post
vector — higher = better fit. The instruction is **not optional**: without it
the vectors only measure topical similarity and unrelated posts score just as
high as real pain points.

```python
task = "Given a product description, retrieve customer complaints and pain points that this product would solve."
product_input = f"Instruct: {task}\nQuery: {product_description}"
# embed(product_input)  -> query vector (with instruction)
# embed(post)           -> document vector (raw)
# cosine(product_vec, post_vec) -> match score
```

Embeddings are a cheap pre-filter: rank posts by cosine, take a generous
top-K, hand those to the LLM (Gemma) for the final relevance judgement.

## First-time deploy

1. **Install Docker + NVIDIA toolkit** (one-time, needs sudo):
   ```bash
   sudo bash setup-docker.sh
   ```
   Then log out/in (or `newgrp docker`) so the `docker` group applies.

2. **Start** — TEI auto-downloads `Qwen/Qwen3-Embedding-4B` into `./data/`
   (HF cache, ~7.6 GB) on first boot:
   ```bash
   docker compose up -d
   ```
   First boot blocks until the model is downloaded + warmed (slow LAN→HF link
   can take ~15 min); subsequent boots load from `./data/` in seconds.

## Manage

```bash
docker compose logs -f        # tail logs
docker compose restart        # restart
docker compose down           # stop
```

## Notes

- **Image tag matters:** use `ghcr.io/huggingface/text-embeddings-inference:86-1.8`
  (CUDA 12.2). Do **not** use `86-1.9` (CUDA 12.9) — this box's driver 570 maxes
  at CUDA 12.8, so 1.9 attempts forward-compat, which is unsupported on the
  GeForce 3090, and TEI silently falls back to **CPU** (log: `Starting Qwen3
  model on Cpu`). On CPU it also tries a huge warmup allocation that OOMs the box.
- **Use `runtime: nvidia`, not `--gpus all`** — on this box `--gpus all` does not
  attach the GPU to the container (TEI logs `CUDA is not available`).
- **Only ~15 GB system RAM:** run a single embedding model at a time. Running the
  old llama.cpp 8B and a TEI model simultaneously thrashed swap and hung the host
  (sshd unresponsive, recovered only via OOM-killer / reboot).
- Confirm GPU backend after start: `docker logs embeddings | grep Cuda` should
  show `Starting FlashQwen3 model on Cuda`.
- Revert to the old llama.cpp 8B: restore `docker-compose.llama-8b.yml.bak` (kept
  on the box) over `docker-compose.yml` and `docker compose up -d`.
