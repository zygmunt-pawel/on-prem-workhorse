#!/bin/bash
set -e

MODEL_PATH="${MODEL_PATH:-/models/gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q6_K_XL.gguf}"
HF_MODEL_URL="${HF_MODEL_URL:-https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/resolve/main/gemma-4-31B-it-UD-Q6_K_XL.gguf}"
DRAFT_PATH="${DRAFT_PATH:-/models/gemma-4-31B-it-GGUF/gemma-4-31B-it-Q8_0-MTP.gguf}"
HF_DRAFT_URL="${HF_DRAFT_URL:-https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/resolve/main/MTP/gemma-4-31B-it-Q8_0-MTP.gguf}"

fetch() {
    local path="$1" url="$2"
    if [ ! -f "$path" ]; then
        echo "Model not found at $path — downloading from Hugging Face..."
        mkdir -p "$(dirname "$path")"
        curl -L --progress-bar -o "$path.tmp" "$url"
        mv "$path.tmp" "$path"
        echo "Download complete."
    else
        echo "Model found at $path"
    fi
}

fetch "$MODEL_PATH" "$HF_MODEL_URL"
# MTP draft model for speculative decoding (-md) — tiny next to the main GGUF
fetch "$DRAFT_PATH" "$HF_DRAFT_URL"

exec llama-server "$@"
