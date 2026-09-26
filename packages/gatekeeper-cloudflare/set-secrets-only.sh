#!/usr/bin/env bash
# Install an already-created Cloudflare dashboard OAuth client's CLIENT_ID/CLIENT_SECRET
# as Worker secrets on gatekeeper-cloudflare. Use this AFTER creating the OAuth client in the
# dashboard (Manage Account -> OAuth clients -> Create client), when the token cannot create the
# client itself (POST /accounts/{acc}/oauth_clients returns 403 code 10000 for API-token auth).
#
# Verified live: the CF_API_TOKEN we hold CAN write these secrets (PUT .../secrets -> success:true),
# it only cannot create the OAuth client. So this script is the minimal, safe completion path.
#
# Usage:
#   export CF_API_TOKEN=<token-with-workers-scripts-edit>
#   bash set-secrets-only.sh <CLIENT_ID> <CLIENT_SECRET>
set -euo pipefail

: "${CF_API_TOKEN:?CF_API_TOKEN must be set}"
CLIENT_ID="${1:?Usage: set-secrets-only.sh <CLIENT_ID> <CLIENT_SECRET>}"
CLIENT_SECRET="${2:?Usage: set-secrets-only.sh <CLIENT_ID> <CLIENT_SECRET>}"

ACC="${CF_ACCOUNT_ID:-6d2a1d5945f8b63047a1d59a9f94de21}"
WORKER="gatekeeper-cloudflare"
API="https://api.cloudflare.com/client/v4"

set_secret() {
  local name="$1" value="$2" out
  out=$(curl -s -X PUT "${API}/accounts/${ACC}/workers/scripts/${WORKER}/secrets" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"${name}\",\"text\":\"${value}\",\"type\":\"secret_text\"}")
  if [ "$(echo "$out" | jq -r '.success')" != "true" ]; then
    echo "!! Failed to set secret ${name}:"; echo "$out" | jq .; exit 1
  fi
  echo ">> Secret ${name} set on Worker ${WORKER}"
}

set_secret "CLIENT_ID" "${CLIENT_ID}"
set_secret "CLIENT_SECRET" "${CLIENT_SECRET}"

echo ">> Current secrets on ${WORKER}:"
curl -s -X GET "${API}/accounts/${ACC}/workers/scripts/${WORKER}/secrets" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | jq -r '.result[].name'

echo ">> DONE. Click Connect on the Cloudflare gatekeeper and verify the OAuth flow live."
