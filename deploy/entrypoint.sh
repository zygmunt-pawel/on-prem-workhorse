#!/bin/bash
set -e

MODEL_PATH="${MODEL_PATH:-/models/gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q6_K_XL.gguf}"
HF_MODEL_URL="${HF_MODEL_URL:-https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/resolve/main/gemma-4-31B-it-UD-Q6_K_XL.gguf}"

if [ ! -f "$MODEL_PATH" ]; then
    echo "Model not found at $MODEL_PATH — downloading from Hugging Face..."
    mkdir -p "$(dirname "$MODEL_PATH")"
    curl -L --progress-bar -o "$MODEL_PATH.tmp" "$HF_MODEL_URL"
    mv "$MODEL_PATH.tmp" "$MODEL_PATH"
    echo "Download complete."
else
    echo "Model found at $MODEL_PATH"
fi

exec llama-server "$@"
