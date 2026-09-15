# Reddit matching vLLM benchmark

**Production, 2026-09-15:** vLLM **0.29.0 / MRV2**, Triton attention,
FlashInfer CUTLASS MoE, FP8 KV, utilization **0.92**, batch **8192**, MTP×4,
450 W. Results later in this document are the historical 0.25 scheduler and
power experiments, with their original settings; they are not new 0.29 runs.
The matrix cleanup restores utilization read from `.env` at startup.

Current evidence and decisions:

- [Version, runner, memory and backend comparison](../../docs/vllm-029-benchmark.md).
- [Full-cache pressure comparison](../../docs/vllm-kv-pressure-benchmark.md):
  shared-prefix long-output batches finished 8.8% sooner on 0.29; short outputs
  were roughly tied or 2.6% faster, depending on prefix sharing.
- [How vLLM uses GPU memory](../../docs/vllm-pamiec-krok-po-kroku.md):
  a step-by-step explanation of the memory budget, KV cache, scheduling and MTP.
- [HTTP batching and continuous load](../../docs/vllm-http-batching-benchmark.md):
  prompt lists versus concurrent requests, shared prefixes, and a continuously
  replenished pool of 64 or 80 requests.
- [Live inventory and post-migration checks](../../deploy/server/VERIFIED_STATE.md).

`compare-versions.py` stops production, tests isolated containers and restarts
the original container in `finally`. Explicit `v025` selects the retained
0.25 image; `v029` selects upstream 0.29. `baseline` always means the current
production image, now 0.29. Default variants are `v025 v029`; b12x is opt-in.
The scheduler matrix also includes the current `fp8-g92-b8192` control and
records the actual image ID/version for each variant.
`cache-pressure.py` now opens one HTTP connection pool per wave and never
retries failed requests. Set the same `--run-id` for paired direct runs when
reusing a live server; different campaigns should use different IDs. Historical
comparisons used the original pool shared across waves, as recorded in the
reports. The initial post-migration disconnect and subsequent check are retained.
The 0.25 image must already exist locally; a fresh 0.29 installation does not
build it. Every run records resolved image IDs and uses separate compile caches.

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
226,341 tokens on the clean 29 August 2026 deployment, where vLLM's startup profiler
accounts for CUDA graph memory inside the 0.90 envelope. The exact pool can vary slightly
with the driver/compiler build. The LeadsRun admission gate keeps 64 sequence slots and
a 220k estimated-token budget, leaving 6,341 tokens of hard KV headroom on this host.
This preserves the measured scheduler optimum while leaving physical fused-MoE
workspace. Lowering the scheduler batch to 6144 or 4096 remains a fallback only if the
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

## HTTP grouping and continuous load

For the tested 8192-input / 512-output profile, keep **8 HTTP requests with
8 prompts each** in flight and replace each completed request immediately.
The final repeated measurements reached **2625 output tokens/s**, **73.6% mean
active KV**, and no preemptions. **16×4 is effectively tied** (2629 tokens/s,
81.3% mean KV). The server sequence limit remains 80. These are workload-specific
results; see the report for short-run reversals and the excluded traffic-contaminated
attempt. Thirty successful continuous phases validated 9960 sequences.

`compare-http-batching.py` tests one `/v1/completions` request containing a list
against concurrent single-prompt requests (`--prompts-per-wave 64` or `80`).
It validates structured JSON separately and measures fixed 8192-input / 512-output
sequences with cold or explicitly prepared shared prefixes. Each case has its own
cache salt and connection pool. Prompt lengths are computed before timed requests;
wall time stops when the last HTTP response has been received and parsed.

`continuous-http-load.py` keeps 64 or 80 single-prompt requests in flight,
replacing each as soon as it completes. It uses 1024 unique precomputed prompts,
20 seconds of warm-up and a 60-second measurement interval, then drains requests.
Two repetitions alternate pool order. Aggregate generation throughput comes from
`vllm:generation_tokens_total`; the reported peak covers at least 10 seconds.
Use `--cases 8x8 10x8` to compare eight or ten HTTP requests, each containing
eight prompts. `--warmup`, `--duration`, and `--repetitions` control screening
and confirmation runs. The fixed input-header label makes prompt banks
comparable across concurrency settings.
KV usage, running/waiting sequences, prefix hits and preemptions are sampled at
250 ms. Total generation counters are checked against completed response usage
to detect unrelated traffic or accounting problems.

Run inside the existing production container with exclusive benchmark access,
`API_KEY` provisioned through the process environment, and an output directory
that already exists. These scripts do not restart or reconfigure vLLM:

```bash
python3 compare-http-batching.py --run-id unique-grouping-run \
  --prompts-per-wave 80 --output /tmp/grouping-result.json
python3 continuous-http-load.py --run-id unique-continuous-run \
  --output /tmp/continuous-result.json
```

The scripts import adjacent helpers, so copy the benchmark directory together.
Use the shared host benchmark lock when orchestrating runs and execute
`deploy/server/verify.sh` afterward. Keep raw artifacts under ignored
`benchmark-results/`; the report and compact measured summaries belong in Git.

`plot-continuous-load.py` renders a completed continuous result with Matplotlib:

```bash
python3 plot-continuous-load.py /tmp/continuous-result.json /tmp/load.svg
```

It plots the first repetition of each case: generation counters over windows
of at least 10 seconds and sampled active KV usage. The committed figure uses
the final confirmation runs; aggregate conclusions use both repetitions.
