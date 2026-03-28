#!/bin/bash
set -e

MODEL_PATH="${MODEL_PATH:-/models/Qwen3.5-27B-IQ4_KS-GGUF/Qwen3.5-27B-IQ4_KS.gguf}"
HF_MODEL_URL="${HF_MODEL_URL:-https://huggingface.co/Pawellll/Qwen3.5-27B-IQ4_KS-GGUF/resolve/main/Qwen3.5-27B-IQ4_KS.gguf}"

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
