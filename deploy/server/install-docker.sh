#!/usr/bin/env bash
set -Eeuo pipefail

# Idempotent Docker Engine + Compose install for a clean Ubuntu host without
# an NVIDIA GPU (for the RTX 5090 host use bootstrap-host.sh instead).
# Needs no repository files, so it can also be streamed over SSH:
#   ssh server@HOST 'bash -s' < deploy/server/install-docker.sh
# Run it as the regular account that should use Docker, normally `server`.

target_user=${TARGET_USER:-$(id -un)}

if [[ $(id -u) -eq 0 ]]; then
  echo "Run this script as $target_user, not as root; it invokes sudo itself." >&2
  exit 2
fi
getent passwd "$target_user" >/dev/null || { echo "Account not found: $target_user" >&2; exit 1; }

[[ -r /etc/os-release ]] || { echo "Cannot identify the operating system." >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && -n ${VERSION_CODENAME:-} ]] || {
  echo "This script supports Ubuntu only; found ${PRETTY_NAME:-unknown}." >&2
  exit 1
}

for command_name in apt-get dpkg-query getent sudo; do
  command -v "$command_name" >/dev/null || {
    echo "Missing base command: $command_name" >&2
    exit 1
  }
done

# `sudo -v` prompts whenever any sudoers rule requires a password (e.g. the
# default %sudo rule), even for NOPASSWD accounts; try non-interactively first.
sudo -n true 2>/dev/null || sudo -v
export NEEDRESTART_MODE=a
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y \
  ca-certificates curl

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

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/install-docker.XXXXXX")
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
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$target_user"
sudo systemctl enable --now docker containerd

echo
echo "Docker install completed."
sudo docker version --format 'Docker Engine: {{.Server.Version}}'
sudo docker compose version
echo "Log out and reconnect before running Docker as $target_user so the new docker-group membership takes effect."
