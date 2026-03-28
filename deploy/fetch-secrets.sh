#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
source "$SCRIPT_DIR/../config.env"

az login --identity --allow-no-subscriptions > /dev/null 2>&1

echo "Fetching secrets from Key Vault: $VAULT_NAME"

export API_KEY=$(az keyvault secret show --vault-name "$VAULT_NAME" --name "$SECRET_LLM_API_KEY" --query value -o tsv)
export SCRAPER_API_KEY=$(az keyvault secret show --vault-name "$VAULT_NAME" --name "$SECRET_SCRAPER_API_KEY" --query value -o tsv)
export CLOUDFLARE_TUNNEL_TOKEN=$(az keyvault secret show --vault-name "$VAULT_NAME" --name "$SECRET_CF_TUNNEL_TOKEN" --query value -o tsv)
export ACR_TOKEN=$(az keyvault secret show --vault-name "$VAULT_NAME" --name "$SECRET_ACR_TOKEN" --query value -o tsv)

cd "$(dirname "$0")/.."
exec docker compose up -d
