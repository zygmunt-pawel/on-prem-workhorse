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
benchmark_repetitions="${BENCHMARK_REPETITIONS:-3}"
benchmark_variants="${BENCHMARK_VARIANTS:-}"

restore_baseline() {
  export VLLM_GPU_MEMORY_UTILIZATION=0.94
  export VLLM_MAX_NUM_BATCHED_TOKENS=8192
  export VLLM_KV_CACHE_DTYPE_SKIP_LAYERS=
  docker compose up -d --force-recreate --no-deps ik-llama >/dev/null 2>&1 || true
}

on_exit() {
  local exit_code="$?"
  trap - EXIT INT TERM
  restore_baseline
  exit "${exit_code}"
}

on_signal() {
  trap - EXIT INT TERM
  restore_baseline
  exit 130
}

trap on_exit EXIT
trap on_signal INT TERM

wait_for_model() {
  local deadline=$((SECONDS + 420))
  local initial_restarts
  initial_restarts="$(docker inspect --format '{{.RestartCount}}' ik-llama 2>/dev/null || echo 0)"
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:8090/health >/dev/null 2>&1; then
      return 0
    fi
    if (( $(docker inspect --format '{{.RestartCount}}' ik-llama 2>/dev/null || echo 0) > initial_restarts )); then
      return 1
    fi
    if [[ "$(docker inspect --format '{{.State.Status}}' ik-llama 2>/dev/null || true)" == "exited" ]]; then
      return 1
    fi
    sleep 5
  done
  return 1
}

record_safe_runtime() {
  docker logs ik-llama 2>&1 \
    | grep -E 'ERROR|Traceback|MemoryError|OutOfMemory|out of memory|CUDA error|RuntimeError|Engine core' \
    | tail -n 240
}

record_safe_startup() {
  docker logs ik-llama 2>&1 \
    | grep -E 'Available KV cache memory|GPU KV cache size|Maximum concurrency for|Capturing CUDA graphs|EngineCore|ERROR|Traceback|ValueError|RuntimeError' \
    | tail -n 80
}

run_variant() {
  local name="$1"
  local batched_tokens="$2"
  local gpu_memory_utilization="$3"
  local skip_layers="$4"
  local variant_dir="${result_root}/${name}"
  mkdir -p "${variant_dir}"

  export VLLM_MAX_NUM_BATCHED_TOKENS="${batched_tokens}"
  export VLLM_GPU_MEMORY_UTILIZATION="${gpu_memory_utilization}"
  export VLLM_KV_CACHE_DTYPE_SKIP_LAYERS="${skip_layers}"

  echo "starting ${name}: max_num_batched_tokens=${batched_tokens}, gpu_memory_utilization=${gpu_memory_utilization}, skip_layers=${skip_layers:-none}"
  docker compose up -d --force-recreate --no-deps ik-llama >/dev/null
  if ! wait_for_model; then
    record_safe_startup >"${variant_dir}/startup.log" || true
    record_safe_runtime >"${variant_dir}/runtime.log" || true
    printf '{"variant":"%s","status":"startup_failed"}\n' "${name}" \
      >"${variant_dir}/status.json"
    echo "${name}: startup failed"
    return 0
  fi

  record_safe_startup >"${variant_dir}/startup.log" || true
  if python3 benchmarks/reddit-matching/benchmark.py \
    --variant "${name}" \
    --repetitions "${benchmark_repetitions}" \
    --output "${variant_dir}/result.json" \
    >"${variant_dir}/console.log" 2>&1; then
    printf '{"variant":"%s","status":"ok"}\n' "${name}" \
      >"${variant_dir}/status.json"
  else
    record_safe_runtime >"${variant_dir}/runtime.log" || true
    printf '{"variant":"%s","status":"benchmark_failed"}\n' "${name}" \
      >"${variant_dir}/status.json"
  fi
  tail -n 24 "${variant_dir}/console.log"
}

run_selected_variant() {
  local name="$1"
  shift
  if [[ -z "${benchmark_variants}" || " ${benchmark_variants} " == *" ${name} "* ]]; then
    run_variant "${name}" "$@"
  fi
}

docker compose build ik-llama

run_selected_variant fp8-g94-b4096 4096 0.94 ""
run_selected_variant fp8-g94-b6144 6144 0.94 ""
run_selected_variant fp8-g94-b8192 8192 0.94 ""
run_selected_variant fp8-g94-b10240 10240 0.94 ""
run_selected_variant fp8-g94-b12288 12288 0.94 ""
run_selected_variant fp8-g92-b12288 12288 0.92 ""
run_selected_variant fp8-g90-b16384 16384 0.90 ""
run_selected_variant fp8-skip-sw-g94-b8192 8192 0.94 sliding_window

python3 benchmarks/reddit-matching/summarize.py "${result_root}"
echo "raw results: ${result_root}"
