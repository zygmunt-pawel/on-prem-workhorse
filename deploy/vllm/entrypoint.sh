#!/usr/bin/env bash
set -euo pipefail

# Keep the production command reproducible while allowing focused scheduler A/B
# tests through environment variables. Do not echo this array: authentication is
# supplied through VLLM_API_KEY and must never appear in startup logs.
args=(
  vllm serve
  --model "${VLLM_MODEL_PATH:-/models/Gemma-4-26B-A4B-NVFP4}"
  --served-model-name
  gemma-4-26B-A4B-it
  Gemma-4-26B-A4B-NVFP4
  gemma-4-31B-it-UD-Q6_K_XL.gguf
  gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf
  --trust-remote-code
  --language-model-only
  --max-model-len "${ON_PREM_VLLM_MAX_MODEL_LEN:-32768}"
  --max-num-seqs "${ON_PREM_VLLM_MAX_NUM_SEQS:-80}"
  --max-num-batched-tokens "${ON_PREM_VLLM_MAX_NUM_BATCHED_TOKENS:-8192}"
  --gpu-memory-utilization "${ON_PREM_VLLM_GPU_MEMORY_UTILIZATION:-0.90}"
  --kv-cache-dtype "${ON_PREM_VLLM_KV_CACHE_DTYPE:-fp8}"
  --moe-backend "${ON_PREM_VLLM_MOE_BACKEND:-auto}"
  --enable-prefix-caching
  --enable-chunked-prefill
  --async-scheduling
  --structured-outputs-config '{"backend":"xgrammar","disable_any_whitespace":true}'
  --speculative-config '{"method":"mtp","model":"/models/gemma-4-26B-A4B-it-assistant","num_speculative_tokens":4}'
)

if [[ -n "${ON_PREM_VLLM_KV_CACHE_DTYPE_SKIP_LAYERS:-}" ]]; then
  IFS=',' read -r -a skip_layers <<< "${ON_PREM_VLLM_KV_CACHE_DTYPE_SKIP_LAYERS}"
  args+=(--kv-cache-dtype-skip-layers "${skip_layers[@]}")
fi

exec "${args[@]}"
