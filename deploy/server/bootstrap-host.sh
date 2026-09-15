#!/usr/bin/env bash
set -Eeuo pipefail

# Idempotent host bootstrap for the clean Ubuntu installed by deploy/autoinstall.
# Run this script as the regular target account, normally `server`.

target_user=${TARGET_USER:-server}
toolkit_version=${NVIDIA_CONTAINER_TOOLKIT_VERSION:-1.20.0-1}
driver_package=${NVIDIA_DRIVER_PACKAGE:-nvidia-driver-595-open}
hf_version=${HUGGINGFACE_HUB_VERSION:-1.29.0}

if [[ $(id -u) -eq 0 ]]; then
  echo "Run this script as $target_user, not as root; it invokes sudo itself." >&2
  exit 2
fi
if [[ $(id -un) != "$target_user" ]]; then
  echo "Current account is $(id -un); expected TARGET_USER=$target_user." >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
power_unit="$script_dir/../systemd/nvidia-power-limit.service"

[[ -r /etc/os-release ]] || { echo "Cannot identify the operating system." >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 26.04 ]] || {
  echo "This runbook is tested only on Ubuntu 26.04; found ${PRETTY_NAME:-unknown}." >&2
  exit 1
}
[[ $(dpkg --print-architecture) == amd64 ]] || {
  echo "This RTX 5090 stack requires Ubuntu amd64." >&2
  exit 1
}
[[ -f "$power_unit" ]] || { echo "Missing repository file: $power_unit" >&2; exit 1; }

passwd_record=$(getent passwd "$target_user" || true)
[[ -n "$passwd_record" ]] || { echo "Account not found: $target_user" >&2; exit 1; }
IFS=: read -r _ _ target_uid target_gid _ target_home _ <<< "$passwd_record"
[[ "$target_uid:$target_gid" == 1000:1000 ]] || {
  echo "Expected $target_user to be UID:GID 1000:1000 (required by the tunnel compose file); found $target_uid:$target_gid." >&2
  exit 1
}

for command_name in apt-get getent sudo; do
  command -v "$command_name" >/dev/null || {
    echo "Missing base command: $command_name" >&2
    exit 1
  }
done

sudo -v
export NEEDRESTART_MODE=a
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y full-upgrade
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y \
  ca-certificates curl git gnupg openssh-server pciutils python3-venv rsync tmux util-linux

if ! lspci | grep -qi nvidia; then
  echo "WARNING: no NVIDIA PCI device is visible. Check card seating, power and firmware settings." >&2
fi

sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y "$driver_package"

# Docker's official apt repository. Refuse legacy/conflicting packages instead
# of silently removing an existing runtime and its state.
conflicts=()
for package_name in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
  if dpkg-query -W -f='${db:Status-Status}' "$package_name" 2>/dev/null | grep -q '^installed$'; then
    conflicts+=("$package_name")
  fi
done
if (( ${#conflicts[@]} > 0 )); then
  echo "Conflicting container packages are installed: ${conflicts[*]}" >&2
  echo "Review and remove them deliberately, then rerun this script." >&2
  exit 1
fi

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/on-prem-bootstrap.XXXXXX")
cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o "$temporary_dir/docker.asc"
sudo install -d -m 0755 /etc/apt/keyrings
sudo install -m 0644 "$temporary_dir/docker.asc" /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$target_user"
sudo systemctl enable --now docker

# NVIDIA Container Toolkit's official apt repository and the version used by
# the verified production host.
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  -o "$temporary_dir/nvidia-container-toolkit.asc"
install -d -m 0700 "$temporary_dir/gnupg"
gpg --batch --no-options --homedir "$temporary_dir/gnupg" --dearmor \
  < "$temporary_dir/nvidia-container-toolkit.asc" \
  > "$temporary_dir/nvidia-container-toolkit-keyring.gpg"
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > "$temporary_dir/nvidia-container-toolkit.list"
sudo install -m 0644 "$temporary_dir/nvidia-container-toolkit-keyring.gpg" \
  /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
sudo install -m 0644 "$temporary_dir/nvidia-container-toolkit.list" \
  /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y \
  "nvidia-container-toolkit=$toolkit_version" \
  "nvidia-container-toolkit-base=$toolkit_version" \
  "libnvidia-container-tools=$toolkit_version" \
  "libnvidia-container1=$toolkit_version"
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Model directories and an isolated, reproducible Hugging Face CLI.
sudo install -d -o "$target_user" -g "$target_user" -m 0755 \
  "$target_home/models/hf" \
  "$target_home/.cache/vllm-gemma4-v029" \
  "$target_home/.venvs"
if [[ ! -x "$target_home/.venvs/huggingface/bin/python" ]]; then
  sudo -u "$target_user" env HOME="$target_home" \
    python3 -m venv "$target_home/.venvs/huggingface"
fi
sudo -u "$target_user" env HOME="$target_home" \
  "$target_home/.venvs/huggingface/bin/python" -m pip install --upgrade pip
sudo -u "$target_user" env HOME="$target_home" \
  "$target_home/.venvs/huggingface/bin/python" -m pip install \
  "huggingface_hub==$hf_version"

# Reapply the benchmarked RTX 5090 power cap after every boot.
sudo install -m 0644 "$power_unit" /etc/systemd/system/nvidia-power-limit.service
sudo systemctl daemon-reload
sudo systemctl enable nvidia-power-limit.service

reboot_required=no
if [[ -f /var/run/reboot-required ]] || ! nvidia-smi >/dev/null 2>&1; then
  reboot_required=yes
else
  sudo systemctl restart nvidia-power-limit.service
fi

echo
echo "Host bootstrap completed."
echo "Driver package: $driver_package"
echo "NVIDIA Container Toolkit: $toolkit_version"
echo "Hugging Face CLI: $hf_version"
if [[ "$reboot_required" == yes ]]; then
  echo "REBOOT REQUIRED: sudo reboot"
else
  nvidia-smi --query-gpu=name,driver_version,memory.total,power.limit \
    --format=csv,noheader
fi
echo "Log out and reconnect before running Docker as $target_user so the new docker-group membership takes effect."

if [[ ${REBOOT_AFTER_INSTALL:-no} == yes ]]; then
  echo "REBOOT_AFTER_INSTALL=yes: rebooting now."
  sudo systemctl reboot
fi
