#!/usr/bin/env bash
# One-time privileged setup for classifier-3090: Docker Engine + NVIDIA Container Toolkit.
#
# Run on the box with:   sudo bash setup-docker.sh
#
# After it finishes, log out and back in (or run `newgrp docker`) so the
# docker group membership takes effect for your user.
set -euo pipefail

echo "==> Installing Docker Engine..."
curl -fsSL https://get.docker.com | sh

TARGET_USER="${SUDO_USER:-$USER}"
echo "==> Adding ${TARGET_USER} to the docker group..."
usermod -aG docker "${TARGET_USER}"

echo "==> Installing NVIDIA Container Toolkit..."
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update
apt-get install -y nvidia-container-toolkit

echo "==> Configuring Docker to use the NVIDIA runtime..."
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

echo "==> Verifying GPU access from a container..."
docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi

echo
echo "Done. Log out and back in (or run 'newgrp docker') before using docker."
