#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Pull latest changes
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Already up to date."
    exit 0
fi

echo "New changes detected, deploying..."
git reset --hard origin/main

# Fetch secrets and restart containers
exec ./deploy/fetch-secrets.sh
