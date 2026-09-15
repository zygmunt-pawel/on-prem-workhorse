#!/usr/bin/env bash
set -Eeuo pipefail

target_repo=nvidia/Gemma-4-26B-A4B-NVFP4
target_revision=a19cfe00be84568a6867111c9a68c9c44fdcffe6
target_directory_name=Gemma-4-26B-A4B-NVFP4

assistant_repo=google/gemma-4-26B-A4B-it-assistant
assistant_revision=6e5aaaf4c42b98394530b8fda2e95cadd65c151c
assistant_directory_name=gemma-4-26B-A4B-it-assistant

if [[ $(id -u) -eq 0 ]]; then
  echo "Run this as the regular server account, not root." >&2
  exit 2
fi

model_root=${MODEL_DIR:-$HOME/models}
hf_root="$model_root/hf"
hf_cli=${HF_CLI:-$HOME/.venvs/huggingface/bin/hf}

[[ "$model_root" == /* ]] || { echo "MODEL_DIR must be an absolute path." >&2; exit 2; }
[[ -x "$hf_cli" ]] || {
  echo "Hugging Face CLI not found at $hf_cli; run bootstrap-host.sh first." >&2
  exit 1
}
command -v flock >/dev/null || { echo "Missing command: flock" >&2; exit 1; }

mkdir -p "$hf_root"
exec 9>"$hf_root/.download.lock"
flock -n 9 || {
  echo "Another model download is already using $hf_root." >&2
  exit 1
}

available_kib=$(df -Pk "$hf_root" | awk 'NR == 2 {print $4}')
minimum_kib=$((22 * 1024 * 1024))
if (( available_kib < minimum_kib )) \
  && [[ ! -f "$hf_root/$target_directory_name/model.safetensors.index.json" \
     || ! -f "$hf_root/$assistant_directory_name/model.safetensors" ]]; then
  echo "At least 22 GiB free is required for the two model snapshots." >&2
  exit 1
fi

download_and_verify() {
  local repo=$1
  local revision=$2
  local destination=$3

  echo "Downloading $repo at immutable revision $revision"
  "$hf_cli" download "$repo" \
    --revision "$revision" \
    --local-dir "$destination"
  echo "Verifying every remote file and checksum in $destination"
  "$hf_cli" cache verify "$repo" \
    --revision "$revision" \
    --local-dir "$destination" \
    --fail-on-missing-files \
    --fail-on-extra-files \
    --format agent
}

download_and_verify \
  "$target_repo" "$target_revision" "$hf_root/$target_directory_name"
download_and_verify \
  "$assistant_repo" "$assistant_revision" "$hf_root/$assistant_directory_name"

echo "Both pinned model snapshots are downloaded and verified under $hf_root."
