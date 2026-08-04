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

1. FP8 KV, `max_num_batched_tokens=8192`;
2. FP8 KV, `16384`;
3. FP8 KV, `32768`;
4. FP8 KV with `sliding_window` layers left in BF16, `16384`;
5. the same hybrid KV layout with `32768`.

All variants keep `max_num_seqs=80`, context 32768, GPU utilization 0.94, prefix
caching, chunked prefill, async scheduling, xgrammar, and MTP×4. The script restores the
8192/full-FP8 baseline on exit; select and deploy the winner explicitly after reviewing
the results.

Run on the RTX 5090 host from the repository root:

```bash
benchmarks/reddit-matching/run-matrix.sh
```

Raw JSON and safe startup excerpts are written below the ignored
`benchmark-results/` directory. `API_KEY` is read from the ignored `.env`, is sent only
as the bearer header, and is never written to a result. The vLLM process receives it as
`VLLM_API_KEY`, not as a command-line argument.

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
