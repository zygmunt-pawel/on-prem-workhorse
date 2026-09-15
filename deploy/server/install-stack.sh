#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "Run this as the regular server account, not root." >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
cd "$repo_root"

for command_name in curl docker; do
  command -v "$command_name" >/dev/null || {
    echo "Missing command: $command_name" >&2
    exit 1
  }
done
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose plugin is unavailable." >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo "Docker is unavailable to $(id -un). Reconnect after bootstrap so docker-group membership is active." >&2
  exit 1
}
nvidia-smi >/dev/null 2>&1 || {
  echo "NVIDIA driver is not active. Reboot after bootstrap and try again." >&2
  exit 1
}

[[ -f .env ]] || {
  echo "Missing $repo_root/.env. Copy .env.example, add the two keys, and chmod 600 it." >&2
  exit 1
}
chmod 600 .env
# This repository owns .env and documents it as shell-compatible KEY=value
# syntax, so loading it also makes the exact paths available to preflight checks.
set -a
# shellcheck disable=SC1091
source ./.env
set +a

[[ -n ${API_KEY:-} ]] || { echo "API_KEY is empty in .env." >&2; exit 1; }
[[ -n ${SCRAPER_API_KEY:-} ]] || { echo "SCRAPER_API_KEY is empty in .env." >&2; exit 1; }
[[ ${MODEL_DIR:-} == /* ]] || { echo "MODEL_DIR must be an absolute path." >&2; exit 1; }
[[ ${VLLM_CACHE_DIR:-} == /* ]] || { echo "VLLM_CACHE_DIR must be an absolute path." >&2; exit 1; }

target_model="$MODEL_DIR/hf/Gemma-4-26B-A4B-NVFP4"
assistant_model="$MODEL_DIR/hf/gemma-4-26B-A4B-it-assistant"
for required_file in \
  "$target_model/config.json" \
  "$target_model/model.safetensors.index.json" \
  "$target_model/model-00001-of-00002.safetensors" \
  "$target_model/model-00002-of-00002.safetensors" \
  "$assistant_model/config.json" \
  "$assistant_model/model.safetensors"; do
  [[ -f "$required_file" ]] || {
    echo "Missing model file: $required_file" >&2
    echo "Run deploy/server/download-models.sh first." >&2
    exit 1
  }
done
mkdir -p "$VLLM_CACHE_DIR"

available_kib=$(df -Pk /var/lib/docker | awk 'NR == 2 {print $4}')
minimum_kib=$((35 * 1024 * 1024))
if ! docker image inspect on-prem-workhorse-vllm:v0.29.0-gemma4-mtp >/dev/null 2>&1 \
  && (( available_kib < minimum_kib )); then
  echo "At least 35 GiB free in Docker storage is required for the first vLLM image build." >&2
  exit 1
fi

docker compose config --quiet
build_options=()
if [[ ${PULL_BASE_IMAGES:-no} == yes ]]; then
  build_options+=(--pull)
fi

echo "Building the scraper and pinned vLLM image. This is safe to rerun after an interrupted SSH session."
docker compose build "${build_options[@]}" scraper ik-llama
docker compose up -d --remove-orphans scraper ik-llama

wait_for_health() {
  local container=$1
  local timeout_seconds=$2
  local elapsed=0
  local state

  while (( elapsed < timeout_seconds )); do
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
    if [[ "$state" == healthy || "$state" == running ]]; then
      echo "$container is $state"
      return 0
    fi
    if [[ "$state" == unhealthy || "$state" == exited || "$state" == dead ]]; then
      echo "$container entered state: $state" >&2
      docker logs --tail 120 "$container" >&2 || true
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo "Timed out waiting for $container after ${timeout_seconds}s." >&2
  docker logs --tail 120 "$container" >&2 || true
  return 1
}

wait_for_health scraper 180
wait_for_health ik-llama "${LLM_HEALTH_TIMEOUT:-900}"

tunnel_id=ca500d27-9a93-440c-9023-e1729c249e1e
tunnel_credential="$HOME/.cloudflared/$tunnel_id.json"
if [[ -f "$tunnel_credential" ]]; then
  chmod 700 "$HOME/.cloudflared"
  chmod 400 "$tunnel_credential"
  docker compose -f deploy/cloudflared/docker-compose.yml config --quiet
  docker compose -f deploy/cloudflared/docker-compose.yml pull cloudflared
  docker compose -f deploy/cloudflared/docker-compose.yml up -d cloudflared
  wait_for_health cloudflared 180
else
  echo "Cloudflare tunnel credential is absent; private LAN services are running, but public ingress was skipped."
  echo "Expected: $tunnel_credential"
fi

echo "Stack installation completed. Run deploy/server/verify.sh."
