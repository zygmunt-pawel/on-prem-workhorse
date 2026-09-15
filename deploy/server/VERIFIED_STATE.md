# Verified production state

This records the RTX 5090 production deployment. Host and model inventory
was fully verified on **2026-09-04**; runtime was migrated on **2026-09-15**
to **vLLM 0.29.0 / Model Runner V2 / Triton attention / FlashInfer CUTLASS MoE**.
GPU memory utilization remains **0.92**, as requested on 15 September.

The [version report](../../docs/vllm-029-benchmark.md) and
[KV-pressure report](../../docs/vllm-kv-pressure-benchmark.md) retain the
original measurements, rejected backends and limits of validation.

## Host (hardware/software inventory from 2026-09-04)

| Item | Verified value |
|---|---|
| Hostname / user | `server` / `server` (UID:GID `1000:1000`) |
| OS | Ubuntu 26.04.1 LTS, amd64 |
| Root storage | 937 GiB filesystem, 58 GiB used after complete deployment |
| GPU | NVIDIA GeForce RTX 5090, 32,607 MiB |
| Secure Boot | disabled; platform in setup mode |
| NVIDIA driver | `nvidia-driver-595-open` `595.84-0ubuntu0.26.04.1` |
| Active power cap | 450 W |
| Docker Engine / Compose | 29.7.2 / 5.5.0 |
| Buildx / containerd | 0.36.1 / 2.3.4 |
| NVIDIA Container Toolkit | 1.20.0-1 |
| Hugging Face CLI | 1.29.0 in `/home/server/.venvs/huggingface` |

`docker`, `ssh.socket` and `nvidia-power-limit.service` were enabled and
active. The power-limit unit completed with exit status 0.

The live repository path is `/home/server/on-prem-workhorse`. At the time of
this record it was an rsync deployment without `.git`, so update it from the
administrator checkout rather than running `git pull` there.

## Immutable model inputs

| Repository | Revision | Local directory | Observed size/files |
|---|---|---|---|
| `nvidia/Gemma-4-26B-A4B-NVFP4` | `a19cfe00be84568a6867111c9a68c9c44fdcffe6` | `/home/server/models/hf/Gemma-4-26B-A4B-NVFP4` | about 18 GiB; 12/12 remote files checksum-verified |
| `google/gemma-4-26B-A4B-it-assistant` | `6e5aaaf4c42b98394530b8fda2e95cadd65c151c` | `/home/server/models/hf/gemma-4-26B-A4B-it-assistant` | about 832 MiB; 7/7 remote files checksum-verified |

The 0.25 compile cache occupied about 233 MiB after its original validation.
It remains at `/home/server/.cache/vllm-gemma4-bench` for rollback. Production
0.29 mounts `/home/server/.cache/vllm-gemma4-v029`; the new cache is independent
of benchmark result directories.

## Runtime configuration

- custom image: `on-prem-workhorse-vllm:v0.29.0-gemma4-mtp`;
- upstream base: `vllm/vllm-openai:v0.29.0`, pinned digest
  `sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1`;
- deployed custom image ID:
  `sha256:b0d4c111e81784027cd5e65fca01e324f58595f34c2d9b6dd52af84db2aeec5e`;
- explicitly selected Model Runner V2 (`VLLM_USE_V2_MODEL_RUNNER=1`);
- explicitly selected attention backend: `TRITON_ATTN`;
- served primary alias: `gemma-4-26B-A4B-it`;
- maximum context per sequence: 32,768 tokens;
- maximum admitted sequences: 80;
- scheduler budget: 8,192 batched tokens;
- GPU memory utilization: 0.92;
- KV cache: FP8; live warm-start pool **8.86 GiB**, estimated **147,129 tokens**;
- prefix caching, chunked prefill and asynchronous scheduling enabled;
- xgrammar structured-output backend;
- Gemma 4 MTP speculative decoding with four draft tokens;
- selected NVFP4 MoE backend: `FLASHINFER_CUTLASS`.

The compatibility fix for the official Gemma 4 assistant is included upstream;
the custom image adds only the production entrypoint. The old patch was removed.
The 0.29 token estimate uses a different async-scheduling formula from 0.25 and
must not be compared directly with the old 258,472-token figure at 0.92.
Physical KV decreased about 5.8% in comparable warm starts (9.41 → 8.86 GiB).

## Services and access

| Container | State | Restart count/policy | Access |
|---|---|---|---|
| `scraper` | running, healthy | 0 / `unless-stopped` | LAN `:3000` |
| `ik-llama` | running, healthy | 0 / `unless-stopped` | LAN `:8090` |
| `cloudflared` | running, healthy | 0 / `unless-stopped` | public `https://model.leads.run` |

The last observed DHCP address was `192.168.1.15`. The tunnel exposes only
`/health` and `/v1/*`; all other public paths terminate at a 404 rule. The
scraper remains LAN-only.

The persistent application/tunnel secrets are:

- `/home/server/on-prem-workhorse/.env` (mode 600);
- `/home/server/.cloudflared/ca500d27-9a93-440c-9023-e1729c249e1e.json`
  (mode 400).

No secret value is recorded here.

No Hugging Face token file was present after the verified downloads. If a
future gated download requires one, it lives in the server account's Hugging
Face cache rather than this repository and may be logged out after verification.

## Migration validation: 2026-09-15 / vLLM 0.29

- Production rebuilt from the digest above; only `ik-llama` was recreated.
- The official Gemma assistant loads without the removed local patch.
- Live logs confirm MRV2, Triton attention, CUTLASS MoE and MTP×4.
- Initial compilation: **8.29 GiB KV**, estimate **137,596 tokens**.
- Controlled restart loaded saved AOT compilation: **8.86 GiB KV**, estimate
  **147,129 tokens**. These are two starts of the same deployed image.
- `deploy/server/verify.sh` passed host/power settings, live version and flags,
  all service health/restart checks, missing-key rejection, authenticated local
  and public model endpoints, structured chat JSON, and a real scraper fetch.
- Production and rollback compile caches remain separate. The old 0.25 image
  is retained locally; current Compose builds only 0.29.

Three production-shaped repetitions completed: **580 responses including
warm-up, 290 full JSON Schema validations**, no request/parse/metrics errors
and no preemptions. Sum of phase medians: **108.037 s**.

| Phase | Median wall time | Median output tok/s |
|---|---:|---:|
| prefilter | 4.464 s | 4048.8 |
| sieve | 67.156 s | 829.2 |
| mixed | 36.417 s | 1015.7 |

The first post-migration pressure attempt recorded one `Server disconnected`
error in 192 requests, 0.155 s after starting a request in wave 2. The engine
remained healthy with no restarts, CUDA errors or preemptions. Reusing an idle
HTTP connection across waves was a plausible cause, not a proven diagnosis.
The benchmark now opens a separate connection pool for each wave and records
errors without retries; `--run-id` prevents reuse of previous prompt caches.
The failed attempt is preserved as `migration/pressure-first-attempt/`.

Two repeat shared-prefix pressure waves with fresh pools used 96 requests each, 12,288
input tokens and exactly 2,048 output tokens per request: **192/192 passed**,
mean wall time **52.194 s**, **0.0 preemption events**. Peak KV usage was
98.48% / 99.70%.
The final verifier passed again after these workloads; all containers were
healthy, with no automatic restarts, and the 450 W cap remained active.

These are post-deployment confirmations on the final custom image at INFO
logging. They do not replace the original paired comparisons. Long-duration
stability and classification quality were not assessed by these synthetic tests.

Raw deployment artifacts: `benchmark-results/vllm-upgrade-20260915/migration/`.

## Historical validation: 2026-09-04 / vLLM 0.25 / utilization 0.90

- local and public health returned HTTP 200;
- missing LLM credentials returned 401, and the correct credential returned
  200;
- a real chat completion succeeded;
- both Hugging Face snapshots passed full remote manifest/checksum validation;
- all three containers stayed at zero restarts;
- no CUDA OOM, preemption, request error or response-parse failure occurred in
  the 64-sequence production-shaped benchmark.

The final production-shaped benchmark measured:

| Phase | Wall time | Aggregate output rate |
|---|---:|---:|
| prefilter | 6.056 s | 2,966.7 output tok/s |
| sieve | 76.680 s | 739.0 output tok/s |
| mixed live wave | 38.764 s | 962.6 output tok/s |

MTP draft-token acceptance was 76.52% and prefix-cache hit rate was 60.34% in
the captured run. Full methodology and rejected settings live in
`benchmarks/reddit-matching/README.md`; those results, rather than intuition,
established the historical 0.90 baseline, 8,192 batched tokens and a 450 W
cap. Utilization was later raised to 0.92; the 0.29 decision is based on the
September 15 version and KV-pressure comparisons linked above.

## Installer artifact baseline

The supported source image is `ubuntu-26.04.1-live-server-amd64.iso` with
SHA-256:

```text
cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927
```

The generated autoinstall ISO is intentionally machine-neutral except for the
`server` account and Pawel's public SSH key. Its own SHA-256 changes on every
build because the discarded password hash is generated anew.
