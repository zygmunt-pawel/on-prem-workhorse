# on-prem-workhorse agent instructions

## Bare-metal recovery and production deployment

The production target is the single **RTX 5090** host. Retired GPU deployment
code has been removed and must not be restored or used as a fallback.

The canonical zero-to-production procedure is
[`deploy/server/README.md`](deploy/server/README.md), and the last verified live
inventory is [`deploy/server/VERIFIED_STATE.md`](deploy/server/VERIFIED_STATE.md).
Read both before rebuilding or changing the host.

Keep the two recovery phases separate:

1. `deploy/autoinstall/` builds a reusable destructive Ubuntu USB. It installs
   only clean, updated Ubuntu 26.04.1 with hostname/user `server`, DHCP and
   Pawel's public SSH key. It erases the largest non-install-media disk and
   powers off without interaction.
2. After SSH works, run the scripts in `deploy/server/` to install the
   `nvidia-driver-595-open` driver, Docker, NVIDIA Container Toolkit, pinned
   model snapshots, the Compose stack and the persistent 450 W power cap.

Never put runtime secrets into the ISO or Git. The server's `.env`, Hugging
Face authentication and Cloudflare tunnel credential are provisioned
separately as described in the runbook. Preserve the tested production values
`VLLM_MAX_NUM_BATCHED_TOKENS=8192`, MTP disabled,
`VLLM_MAX_NUM_SEQS=64` and the 450 W cap unless a new benchmark proves a change
is better and stable. The 2026-09-15 continuous-JSON campaign replaced the
earlier MTPx4 / 80-sequence defaults.
The user explicitly changed `VLLM_GPU_MEMORY_UTILIZATION` from `0.90` to `0.92`
on 2026-09-15 for more KV cache. Keep `0.92` as the configured value; retain
`0.90` as the previous benchmarked fallback. See
`docs/vllm-pamiec-krok-po-kroku.md` for the tutorial explaining memory and runtime settings;
measurements and validation scope are in `docs/vllm-029-benchmark.md`.

Production was migrated on 2026-09-15 to digest-pinned **vLLM 0.29.0** with
**Model Runner V2**, `TRITON_ATTN` attention and `flashinfer_cutlass` MoE.
Keep these selected backends; FlashInfer attention and both b12x paths failed
startup in the tested configuration. The old Gemma MTP compatibility patch is
upstream and must not be reapplied to 0.29. See `docs/vllm-029-benchmark.md`
and `docs/vllm-kv-pressure-benchmark.md` for measured gains and limitations.
Historical benchmark results retain their original versions and settings.
