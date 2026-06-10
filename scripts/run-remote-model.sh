#!/usr/bin/env bash

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-local-classifier}"
API_KEY="${API_KEY:-}"
PORT="${PORT:-8090}"
NETWORK="${NETWORK:-on-prem-workhorse_default}"
CONTAINER_NAME="${CONTAINER_NAME:-ik-llama}"
IMAGE="${IMAGE:-on-prem-workhorse-ik-llama}"
MODEL_DIR="${MODEL_DIR:-/home/pawel/models}"

usage() {
  cat <<'EOF'
Usage:
  API_KEY=... scripts/run-remote-model.sh <preset> [context]

Presets:
  gemma31-q6
  gemma31-q5
  gemma26-a4b-q8
  gemma26-a4b-q8-128k

Examples:
  API_KEY=... scripts/run-remote-model.sh gemma31-q6
  API_KEY=... scripts/run-remote-model.sh gemma26-a4b-q8 131072
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

if [[ -z "$API_KEY" ]]; then
  echo "API_KEY is required" >&2
  exit 1
fi

PRESET="$1"
CTX_OVERRIDE="${2:-}"
MODEL_PATH=""
CTX_DEFAULT=""

case "$PRESET" in
  gemma31-q6)
    MODEL_PATH="/models/gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q6_K_XL.gguf"
    CTX_DEFAULT="131072"
    ;;
  gemma31-q5)
    MODEL_PATH="/models/gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q5_K_XL.gguf"
    CTX_DEFAULT="20000"
    ;;
  gemma26-a4b-q8)
    MODEL_PATH="/models/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q8_K_XL.gguf"
    CTX_DEFAULT="8192"
    ;;
  gemma26-a4b-q8-128k)
    MODEL_PATH="/models/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q8_K_XL.gguf"
    CTX_DEFAULT="131072"
    ;;
  *)
    echo "Unknown preset: $PRESET" >&2
    usage
    exit 1
    ;;
esac

CTX="${CTX_OVERRIDE:-$CTX_DEFAULT}"

ssh -o BatchMode=yes "$REMOTE_HOST" bash -s -- \
  "$CONTAINER_NAME" "$NETWORK" "$MODEL_DIR" "$IMAGE" "$MODEL_PATH" "$CTX" "$PORT" "$API_KEY" <<'REMOTE'
set -euo pipefail

container_name="$1"
network_name="$2"
model_dir="$3"
image_name="$4"
model_path="$5"
ctx="$6"
port="$7"
api_key="$8"

docker rm -f "$container_name" >/dev/null 2>&1 || true

docker run -d \
  --name "$container_name" \
  --gpus all \
  --network "$network_name" \
  --network-alias "$container_name" \
  -p "${port}:8090" \
  -v "${model_dir}:/models" \
  "$image_name" \
  -m "$model_path" \
  -ngl 999 \
  -fa 1 \
  -c "$ctx" \
  -ctk q4_0 \
  -ctv q4_0 \
  --host 0.0.0.0 \
  --port 8090 \
  -np 1 \
  --api-key "$api_key" >/dev/null

echo "Started $model_path with -c $ctx on $container_name"
REMOTE
