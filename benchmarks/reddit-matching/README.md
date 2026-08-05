# Reddit matching vLLM benchmark

Controlled scheduler benchmark for the two physical request shapes used by the
LeadsRun Reddit matching pipeline. It is designed to answer configuration questions
for this exact service rather than extrapolate from a generic one-prompt benchmark.

The fixture contains no production project or Reddit data. It deterministically builds
synthetic English content while preserving the production characteristics observed in
API logs:

- prefilter: eight independent sequences per `/v1/completions` request, four posts per
  sequence, about 17–21k prompt tokens per physical request, `max_tokens=1000`;
- detailed sieve: four independent sequences, one post per sequence, the production-like
  strict JSON schema, about 27–30k prompt tokens per request, `max_tokens=2500`;
- shared system/project prefixes, compact deterministic output, and up to 64 active
  sequences;
- separate prefilter-only, sieve-only, and mixed phases, each repeated three times after
  an identical warm-up.

For every phase the harness records wall time, prompt/output throughput, physical-request
latency, average TTFT from vLLM metrics, MTP acceptance, prefix-cache hit rate,
preemptions, parse failures, finish reasons, GPU utilization, power, and VRAM usage.

## Matrix

`run-matrix.sh` rebuilds the local image once and recreates only `ik-llama` for:

1. full FP8 KV at `max_num_batched_tokens` 4096, 6144, 8192, 10240, and
   12288 with `gpu_memory_utilization=0.94`;
2. full FP8 at 12288 with utilization 0.92 and at 16384 with utilization 0.90,
   leaving progressively more transient MoE workspace;
3. 8192 with sliding-window KV left in BF16 as a heterogeneous-cache control.

All variants keep `max_num_seqs=80`, context 32768, prefix caching, chunked prefill,
async scheduling, xgrammar, and MTP×4. The script restores the 8192/full-FP8 baseline
on every exit, including interruption. Set `BENCHMARK_VARIANTS` to a space-separated
subset for a focused rerun and `BENCHMARK_REPETITIONS` to change the default three
repetitions:

Run on the RTX 5090 host from the repository root:

```bash
benchmarks/reddit-matching/run-matrix.sh

BENCHMARK_REPETITIONS=1 \
BENCHMARK_VARIANTS="fp8-g94-b6144 fp8-g94-b8192" \
benchmarks/reddit-matching/run-matrix.sh benchmark-results/focused
```

`BENCHMARK_PREFILTER_MAX_TOKENS` and `BENCHMARK_SIEVE_MAX_TOKENS` support focused
output-budget experiments without changing the production-shaped defaults. Fixture
salts are deterministic across variants, so prompt bytes are directly comparable.

Raw JSON and safe startup excerpts are written below the ignored
`benchmark-results/` directory. `API_KEY` is read from the ignored `.env`, is sent only
as the bearer header, and is never written to a result. The vLLM process receives it as
`VLLM_API_KEY`, not as a command-line argument.

## Result and production decision

The 4 August 2026 isolated production-shape run selected full FP8 KV, utilization 0.94, and
`max_num_batched_tokens=8192`. The three-repetition confirmation processed one
256-post prefilter wave in a median 4.72 seconds at 96.6% average GPU utilization,
without request, protocol, or preemption errors. One-pass screening of the larger
configuration space produced:

| Variant | Prefilter | Sieve | Mixed | Total |
|---|---:|---:|---:|---:|
| FP8, 0.94, 4096 | 8.55 s | 72.06 s | 39.70 s | 120.30 s |
| FP8, 0.94, 6144 | 5.79 s | 73.60 s | 42.24 s | 121.63 s |
| FP8, 0.94, 8192 | **4.93 s** | **65.97 s** | 40.22 s | **111.13 s** |
| FP8, 0.94, 10240 | 5.53 s | 74.57 s | 42.19 s | 122.29 s |
| FP8, 0.94, 12288 | 9.36 s | 71.51 s | 41.40 s | 122.27 s |
| FP8, 0.92, 12288 | 4.83 s | 74.40 s | 41.49 s | 120.73 s |
| FP8, 0.90, 16384 | 7.82 s | 73.42 s | 38.83 s | 120.07 s |
| Hybrid FP8/BF16, 0.94, 8192 | 10.69 s | 86.98 s | 44.79 s | 142.46 s |

The 10240+ settings therefore do not turn a larger scheduler step into higher sustained
throughput. At 16384/0.94 the engine reset during the prefilter load. At 32768/0.94 it
failed during startup when the FlashInfer CUTLASS MoE warm-up requested another
2.82 GiB with only about 1 GiB physically free. Lower utilization made the larger
variants stable but still slower than 8192.

The heterogeneous cache is especially unsuitable for Gemma 4: page alignment between
its 256-wide sliding heads, 512-wide global heads, and padded speculative pages reduced
the usable pool to only 80,798 tokens and made every phase slower. Full FP8 provides
274,617 tokens. That isolated result originally led to a 250k estimated-token admission
budget and 64 active sequences against the server's ceiling of 80.

## Mixed-production OOM and revised safety envelope

On 5 August 2026 the real shared workload combined Reddit `/completions` waves with
AiPipeline `/chat/completions`. EngineCore failed three times in the FlashInfer CUTLASS
fused-MoE workspace. Every failure requested another 724 MiB while only 495–575 MiB was
physically free. One failure happened with only seven running sequences and about 10%
KV occupancy, proving that `max_num_seqs` alone was not the controlling limit. Logs also
showed 1.01–1.09 GiB reserved but unallocated in the PyTorch allocator.

The production safety envelope is therefore revised to full FP8 KV,
`gpu_memory_utilization=0.90`, `max_num_batched_tokens=8192`, `max_num_seqs=80`, MTP×4,
and `PYTORCH_ALLOC_CONF=expandable_segments:True`. The resulting dynamic KV pool contains
247,029 tokens. The LeadsRun admission gate keeps 64 sequence slots but lowers its
estimated-token budget to 220k, leaving 27,029 tokens of hard KV headroom. This
preserves the measured scheduler optimum while leaving physical workspace and KV
headroom. Lowering the scheduler batch to 6144 or 4096 remains a fallback only if the
revised envelope still reproduces an OOM under the same mixed workload.

## Why FP8 is the baseline

FP8 already halves KV storage relative to BF16. The server's earlier patched INT4
per-token/head experiment was rejected: Gemma 4 mixes 25 sliding-attention layers with
256-wide heads and five full-attention layers with 512-wide heads, so page alignment and
scale overhead increased full-32k concurrency only from roughly 8.8 to 9.9, while
single-request decode fell from about 294 to 207 tok/s.

The vLLM 0.25 image exposes an `nvfp4` cache dtype, but its FlashInfer implementation is
restricted to the SM100 TRT-LLM attention path. The RTX 5090 is SM120 and that backend
rejects it. TurboQuant is also not a production alternative for this model: heterogeneous
Gemma 4 page sizes remain problematic, and its interaction with speculative decoding is
not yet sufficiently stable. These formats should be reconsidered after upstream SM120
kernel support, not carried as production patches.
