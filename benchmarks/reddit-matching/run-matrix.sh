#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

if [[ ! -f .env ]]; then
  echo ".env is required in ${repo_root}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

result_root="${1:-benchmark-results/reddit-matching-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "${result_root}"

export VLLM_MAX_MODEL_LEN=32768
export VLLM_MAX_NUM_SEQS=80
export VLLM_GPU_MEMORY_UTILIZATION=0.94
export VLLM_KV_CACHE_DTYPE=fp8

restore_baseline() {
  export VLLM_MAX_NUM_BATCHED_TOKENS=8192
  export VLLM_KV_CACHE_DTYPE_SKIP_LAYERS=
  docker compose up -d --force-recreate --no-deps ik-llama >/dev/null 2>&1 || true
}
trap restore_baseline EXIT INT TERM

wait_for_model() {
  local deadline=$((SECONDS + 900))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:8090/health >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Status}}' ik-llama 2>/dev/null || true)" == "exited" ]]; then
      return 1
    fi
    sleep 5
  done
  return 1
}

record_safe_startup() {
  docker logs ik-llama 2>&1 \
    | grep -E 'Available KV cache memory|GPU KV cache size|Maximum concurrency for|Capturing CUDA graphs|EngineCore|ERROR|Traceback|ValueError|RuntimeError' \
    | tail -n 80
}

run_variant() {
  local name="$1"
  local batched_tokens="$2"
  local skip_layers="$3"
  local variant_dir="${result_root}/${name}"
  mkdir -p "${variant_dir}"

  export VLLM_MAX_NUM_BATCHED_TOKENS="${batched_tokens}"
  export VLLM_KV_CACHE_DTYPE_SKIP_LAYERS="${skip_layers}"

  echo "starting ${name}: max_num_batched_tokens=${batched_tokens}, skip_layers=${skip_layers:-none}"
  docker compose up -d --force-recreate --no-deps ik-llama >/dev/null
  if ! wait_for_model; then
    record_safe_startup >"${variant_dir}/startup.log" || true
    printf '{"variant":"%s","status":"startup_failed"}\n' "${name}" \
      >"${variant_dir}/status.json"
    echo "${name}: startup failed"
    return 0
  fi

  record_safe_startup >"${variant_dir}/startup.log" || true
  if python3 benchmarks/reddit-matching/benchmark.py \
    --variant "${name}" \
    --repetitions 3 \
    --output "${variant_dir}/result.json" \
    >"${variant_dir}/console.log" 2>&1; then
    printf '{"variant":"%s","status":"ok"}\n' "${name}" \
      >"${variant_dir}/status.json"
  else
    printf '{"variant":"%s","status":"benchmark_failed"}\n' "${name}" \
      >"${variant_dir}/status.json"
  fi
  tail -n 24 "${variant_dir}/console.log"
}

docker compose build ik-llama

run_variant fp8-b8192 8192 ""
run_variant fp8-b16384 16384 ""
run_variant fp8-b32768 32768 ""
run_variant fp8-skip-sw-b16384 16384 sliding_window
run_variant fp8-skip-sw-b32768 32768 sliding_window

python3 benchmarks/reddit-matching/summarize.py "${result_root}"
echo "raw results: ${result_root}"
