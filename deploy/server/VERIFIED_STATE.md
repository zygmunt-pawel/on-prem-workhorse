# Verified production state

This records the RTX 5090 production deployment. Host and model inventory
was fully verified on **2026-09-04**; runtime was migrated on **2026-09-15**
to **vLLM 0.29.0 / Model Runner V2 / Triton attention / FlashInfer CUTLASS MoE**.
GPU memory utilization remains **0.92**, as requested on 15 September.
Priority scheduling was enabled later on the same day.

**Current production profile, later on 2026-09-15:** after the
[JSON tuning campaign](../../docs/vllm-json-tuning-benchmark.md) and a separate
prefix-cache-disabled control, the engine is **MTP disabled /
max_num_seqs=64 / budget 8192**, with prefix caching enabled, 32k context,
utilization 0.92, 450 W and the original API key. The winning settings are now
persistent in Compose, the entrypoint and server `.env`; normal recreation no
longer returns to MTP×4 / 80.

The [version report](../../docs/vllm-029-benchmark.md) and
[KV-pressure report](../../docs/vllm-kv-pressure-benchmark.md) retain the
original measurements, rejected backends and limits of validation.
[HTTP batching and continuous load](../../docs/vllm-http-batching-benchmark.md)
compare client request grouping with the same production runtime.
[Public-route concurrency](../../docs/vllm-network-concurrency-benchmark.md)
separately measures variable JSON outputs and a temporary active-sequence cap.

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

## Committed deployment configuration

- custom image: `on-prem-workhorse-vllm:v0.29.0-gemma4-mtp`;
- upstream base: `vllm/vllm-openai:v0.29.0`, pinned digest
  `sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1`;
- deployed custom image ID:
  `sha256:43a6717879ade61678ca52a4c208c7698cbdb8c5f11203997c16689098ba367f`;
- explicitly selected Model Runner V2 (`VLLM_USE_V2_MODEL_RUNNER=1`);
- explicitly selected attention backend: `TRITON_ATTN`;
- served primary alias: `gemma-4-26B-A4B-it`;
- maximum context per sequence: 32,768 tokens;
- maximum admitted sequences: 64;
- scheduling policy: `priority` (lower request values first, default `0`);
- scheduler budget: 8,192 batched tokens;
- GPU memory utilization: 0.92;
- KV cache: FP8; live warm-start pool **10.26 GiB / 170,293 tokens** with MTP disabled;
- prefix caching, chunked prefill and asynchronous scheduling enabled;
- xgrammar structured-output backend;
- Gemma 4 MTP speculative decoding disabled (`VLLM_MTP_NUM_SPECULATIVE_TOKENS=0`);
- selected NVFP4 MoE backend: `FLASHINFER_CUTLASS`.

The compatibility fix for the official Gemma 4 assistant is included upstream;
the custom image adds only the production entrypoint. The old patch was removed.
The 0.29 token estimate uses a different async-scheduling formula from 0.25 and
must not be compared directly with the old 258,472-token figure at 0.92.
Physical KV decreased about 5.8% in comparable warm starts (9.41 → 8.86 GiB).

## Services and access

| Container | State | Restart count/policy | Access |
|---|---|---|---|
| `ik-llama` | running, healthy | 0 / `unless-stopped` | LAN `:8090` |
| `cloudflared` | running, healthy | 0 / `unless-stopped` | public `https://model.leads.run` |

The last observed DHCP address was `192.168.1.15`. The tunnel exposes only
`/health` and `/v1/*`; all other public paths terminate at a 404 rule.

**2026-09-26:** the unused `scraper` service was removed from the host and the
repository (container, `on-prem-workhorse:latest` image, source and the
`SCRAPER_API_KEY`/`PROXY_URL` settings). `ik-llama` was not recreated. Earlier
entries below that mention scraper checks describe the verifier as it was then.

The persistent application/tunnel secrets are:

- `/home/server/on-prem-workhorse/.env` (mode 600);
- `/home/server/.cloudflared/ca500d27-9a93-440c-9023-e1729c249e1e.json`
  (mode 400).

No secret value is recorded here.

No Hugging Face token file was present after the verified downloads. If a
future gated download requires one, it lives in the server account's Hugging
Face cache rather than this repository and may be logged out after verification.

## Production JSON tuning: 2026-09-15

The [further tuning campaign](../../docs/vllm-json-tuning-benchmark.md) completed
18 valid measured phases, validating **12,760 JSON outputs**. It tested MTP×2,
×1 and off; budgets 6144, 8192 and 10240; then active caps 48, 56 and 64.
Every phase used 100 individual requests in flight, the same 8192-token
synthetic prompts, approximately 142 output tokens, public HTTPS and priority 0.
There were no request errors, token-accounting mismatches or measured preemptions.

The selected configuration was **MTP off / budget 8192 / cap 64**. Its final
two confirmations averaged **8.79 JSON/s / 1251 output tokens/s**, versus
**7.91 / 1139** in the final MTP×2 / 8192 / 56 control: +11.0% JSON/s.
Mean measured active KV was 76.2%, sampled GPU utilization 95.1%.
The evidence for disabling MTP is stronger than the small cap-64 gain over
cap 56; the report separates initial selection and final confirmation.

The user requested keeping the selected runtime. Automatic restoration had
started and was interrupted; the selected container was then recreated with
the **original API key**. It has 32k context, utilization 0.92, 450 W,
the same image/backends, no MTP and a warm **10.26 GiB** KV pool.
The normal API key, missing-key rejection, structured chat JSON, local/public
health and models, scraper fetch, service restart counts and power cap passed
the adapted verifier. `.env` SHA-256 is unchanged; the temporary key was removed.

The selected settings were initially retained through
`benchmark-results/json-tuning-20260915/entrypoint-0-8192-64.sh` and
`compose-0-8192-64.json`. After the prefix-cache control confirmed the choice,
they were promoted to the root Compose definition, production entrypoint,
`.env.example`, server `.env` and `deploy/server/verify.sh`. The production
verifier now requires cap 64, prefix caching and absence of
`--speculative-config`.

The persistent promotion rebuilt the custom image and recreated only
`ik-llama`; the benchmark entrypoint bind-mount is absent from the resulting
container. Its live argv has `--max-num-seqs 64`, `--enable-prefix-caching`,
`--scheduling-policy priority` and no `--speculative-config`. The environment
has `VLLM_MTP_NUM_SPECULATIVE_TOKENS=0`, the warm KV allocation is 10.26 GiB /
170,293 tokens, and the new image ID is recorded above. The full production
verifier passed with zero container restarts: host/GPU/450 W, runtime backends,
priority request, local and public auth/health/models, structured JSON, scraper
auth/fetch and Cloudflare health.

Artifacts: `benchmark-results/json-tuning-20260915/`, including
`restore-cancelled.json`, `kept-best.json` and `verification-kept.log`.
Compact results: `benchmarks/reddit-matching/json-tuning-results-20260915.json`.

### Prefix-cache-disabled control

To isolate MTP from shared-prefix reuse, a clean control used explicit
`--no-enable-prefix-caching`, cap 40, 100 requests in flight and two warm
60-second windows per variant. Both sides had zero cache hits and zero
preemptions. MTP-off delivered **3.207 JSON/s / 453.1 output tokens/s** versus
**3.129 / 438.2** for MTP×2: +2.47% JSON/s and +3.42% output tokens/s.
MTP shortened decode by only about 0.8%, while its mean prefill time was 0.701 s
versus 0.526 s without MTP and active KV was 87.4% versus 75.7%.

This confirms that MTP is a net loss even with cache reuse removed for this
short-output profile. The much larger cached-workload advantage is mainly the
interaction of MTP with prefix-cache coverage and the smaller KV pool; these
nonlinear effects are not treated as an additive decomposition. Prefix caching
itself remains essential: disabling it reduced throughput from about 8.8 to
3.2 JSON/s. Raw artifacts and summary:
`benchmark-results/prefix-control-20260915/`.

### Cap and client-pool follow-up

A later public-route follow-up compared cap 64 and 72 with client pools 80,
100 and 120; the user stopped it before cap 80. Cap 72's best comparable mean
was only about 1.6% higher in JSON/s than cap 64 / pool 80, while output tok/s
was 2.1% lower, mean KV 9.5 percentage points higher and HTTP p95 27.6% higher.
It did not clear the previously defined practical 2% threshold. Larger client
pools mostly increased queueing; pool 80 is recommended for this synthetic
8k-prompt/short-JSON profile.

Two cap-64 public-route repetitions were excluded because the client path
underfilled the engine; no engine errors, preemptions or restarts occurred.
After the user stopped the campaign, production was recreated at cap 64 with
the original API key. The full verifier passed and the temporary key was
removed. Report: [cap/client follow-up](../../docs/vllm-cap-client-followup.md).
Compact data: `benchmarks/reddit-matching/cap-client-results-20260915.json`.

## Public-route concurrency validation: 2026-09-15

The [network benchmark](../../docs/vllm-network-concurrency-benchmark.md)
compared client pools, HTTP grouping and variable-length JSON outputs via
Cloudflare. Twenty valid phases completed **11,711 sequences**, including
**9,134 schema-validated JSON outputs**. Two rejected phases remain documented:
unrelated inference before access isolation, and a connection-establishment
error during the first 128-request trial; its repeat passed.

For 8,192-token prompts and this synthetic JSON schema (about 142 output tokens),
the best tested combination was a temporary engine cap of 56 and 100 individual
requests in flight: **7.64 JSON/s / 1,081 output tokens/s**, mean active KV 82.3%,
mean sampled GPU utilization 91.6%, no preemption in that phase. A 100-request
pool with the original engine cap of 80 delivered 6.64 JSON/s in its longer
confirmation. This is workload-specific evidence, not a global replacement
for the production scheduler limit.

The cap-56 initial compilation gave 8.38 GiB KV; a second, warm start gave
8.96 GiB, used for both cap-56 measurements. The original `.env` was untouched;
temporary API-key and sequence-limit overrides were confined to test containers.
At the end of that earlier campaign, production was restored to
**max_num_seqs=80**, priority scheduling and the original API key. Later
campaigns replaced it with the current no-MTP / 64 profile. Restoration verification is retained under
`benchmark-results/network-auth-20260915/` on the server, with a copy alongside
the client-side network artifacts. Runtime flags, authentication, structured
JSON, scraper fetch, public access and the 450 W limit are checked again.

## MTP depth validation: 2026-09-15

The [MTP JSON comparison](../../docs/vllm-mtp-json-benchmark.md) tested two,
three and four draft tokens at a temporary cap of 56 / 100 individual requests
in flight. Two 90-second measurements per setting validated **5401 JSONs**,
with no request errors or measured preemptions. Mean throughput was 7.64 JSON/s
for MTP×4, 7.90 for ×3 and 7.92 for ×2. The latter two are effectively tied
at this measurement scope. Warm KV pools were 8.96 / 9.02 / 9.06 GiB respectively.
The separately prepared shorter profile was cancelled before inference.

The then-current production configuration (80 sequences / MTP×4 / original API key)
was restored after that test, and the full deployment verifier passed. Raw artifacts and
restoration verification: `benchmark-results/mtp-network-20260915/`.

## Context-limit validation: 2026-09-15

A [short 16k comparison](../../docs/vllm-mtp-json-benchmark.md#limit-kontekstu-16k-i-większa-liczba-aktywnych-sekwencji)
used MTP×2 and 100 individual in-flight requests, testing active caps 56, 80 and
100 with the same 8192-token JSON prompts. One 60-second measurement per cap
validated **1827 JSONs**. At cap 56, KV stayed 9.06 GiB and throughput was
1133 output tokens/s, matching the earlier 32k baseline. Caps 80 / 100 gave
972 / 979 tokens/s, about 96% mean active KV and three preemptions each.
There is no measured throughput benefit from lowering the context limit or
raising active concurrency for this profile. Warm KV at caps 80 / 100 was
8.92 / 8.85 GiB. The then-current 32k / 80 / MTP×4 configuration and original
API key were restored; the full deployment verifier passed. Artifacts:
`benchmark-results/context16k-20260915/`.

## Priority scheduling validation: 2026-09-15

Rebuilt the entrypoint image and recreated only `ik-llama` to enable
`--scheduling-policy priority`. The live argv and API accept nonzero priority.
Warm-start KV remains **8.86 GiB / 147,129 estimated tokens**.

Two isolated trials each filled all 80 active slots with 1,024-token
generations, then confirmed eight ordinary requests waiting before submitting
one urgent request (`priority=-10`, ordinary `0`). The urgent response's first
text arrived before every queued ordinary response in both trials. All
**178/178 streaming completions** passed output-token count, finish reason
and stream-completion checks. The urgent requests still waited **6.05 / 5.88 s**
for their first text under full occupancy; priority is not immediate preemption
of all running work or a latency guarantee.

The public tunnel was paused for isolation and restored afterward. Deployment
verification checks priority in the live process and sends a structured chat
request with `priority=-10`. The test does not establish optimal client
concurrency, WAN performance, or throughput under mixed priorities. Earlier
version/cache/HTTP benchmarks retain their original FCFS measurements.
All deployment checks passed after restoration: service health, zero automatic
restarts, local/public authentication, structured JSON, scraper fetch and 450 W.

Reproducer: `benchmarks/reddit-matching/verify-priority.py`.
Raw results and verification: `benchmark-results/priority-20260915/`.
The previous custom image is retained as
`on-prem-workhorse-vllm:before-priority-20260915`; upstream vLLM is unchanged.

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
