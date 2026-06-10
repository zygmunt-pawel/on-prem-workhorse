## Gemma draft benchmarks on `local-classifier`

Date: 2026-04-09
Host: `local-classifier` (`classifier-gpu`)
GPU: `NVIDIA GeForce RTX 5090 32 GB`

### Main model

- `gemma-4-31B-it-UD-Q5_K_XL.gguf`

### Baseline without draft

Request shape:

- Prompt: `Reply with exactly one word: ok`
- `max_tokens=4`
- `temperature=0`

Measured on the second request after startup:

- `prompt_ms = 50.621`
- `predicted_ms = 61.961`
- `predicted_tps = 64.557 tok/s`

First request after restart was very slow:

- `prompt_ms = 99576.351`
- `predicted_ms = 6689.017`
- `predicted_tps = 0.598 tok/s`

### Draft setup that worked

Main:

- `gemma-4-31B-it-UD-Q5_K_XL.gguf`

Draft:

- `gemma-4-E2B-it-Q4_K_M.gguf`

Important runtime params:

- `-md /models/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf`
- `-ctkd q8_0`
- `-ctvd q8_0`
- `--draft-max 8`
- `--draft-min 2`
- `--draft-p-min 0.75`
- `-cd 4096`

Measured on the second request after startup:

- `prompt_ms = 53.063`
- `predicted_ms = 25.020`
- `predicted_tps = 159.872 tok/s`

Observed draft stats:

- `draft acceptance rate = 1.00000`

First request after restart was still very slow:

- `prompt_ms = 99866.876`
- `predicted_ms = 21473.999`
- `predicted_tps = 0.186 tok/s`

### Comparison

- Baseline second request: `64.557 tok/s`
- Draft second request: `159.872 tok/s`
- Approx speedup: `2.48x`

### Setup that did not fit

Main:

- `gemma-4-31B-it-UD-Q6_K_XL.gguf`

Draft:

- `gemma-4-E2B-it-Q4_K_M.gguf`

Result:

- Main model loaded
- Draft context failed with GPU OOM
- Log included:
  - `failed to allocate compute pp buffers`
  - `failed to create draft context`

VRAM near failure:

- `31954 MiB / 32607 MiB`

### Current follow-up

- Download in progress:
  - `unsloth/gemma-4-E4B-it-GGUF`
  - file: `gemma-4-E4B-it-Q4_K_M.gguf`
- Goal:
  - compare `31B Q5 + E4B draft` vs `31B Q5 + E2B draft`
