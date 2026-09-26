#!/usr/bin/env bash
# Turnkey: create the Cloudflare dashboard OAuth client for the gatekeeper-cloudflare
# Worker and install its CLIENT_ID/CLIENT_SECRET as Worker secrets — one shot.
#
# Every value below is verified against the live sources, not guessed:
#   - OAuth server:  src/oauth.ts -> https://dash.cloudflare.com/oauth2/{auth,token} (hardcoded)
#   - Redirect URI:  ${BASE_URL}/oauth, BASE_URL from wrangler.jsonc (live var)
#   - Scopes:        BILLING_SCOPES + workers-observability.read (src/oauth.ts)
#   - Auth method:   client_secret_basic (basicAuth() in src/oauth.ts)
#   - Create API:    POST /accounts/{acc}/oauth_clients  (IAM oauth_clients)
#
# REQUIRES: CF_API_TOKEN with the "OAuth Client Write" permission group.
# Without it the create call returns HTTP 403 (Authentication error, code 10000).
# The token is account governance — only the board can add that permission.
set -euo pipefail

: "${CF_API_TOKEN:?CF_API_TOKEN must be set}"
ACC="${CF_ACCOUNT_ID:-6d2a1d5945f8b63047a1d59a9f94de21}"
WORKER="gatekeeper-cloudflare"
REDIRECT="https://cloudflareos.vonbusch.app/gatekeeper/cloudflare/oauth"
API="https://api.cloudflare.com/client/v4"

echo ">> Creating OAuth client on account ${ACC} ..."
CREATE_BODY=$(cat <<JSON
{
  "client_name": "CloudflareOS Gatekeeper (vonbusch.app)",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic",
  "redirect_uris": ["${REDIRECT}"],
  "scopes": [
    "offline_access",
    "aig.read",
    "aig.run",
    "user-details.read",
    "account-settings.read",
    "workers-observability.read"
  ]
}
JSON
)

RESP=$(curl -s -X POST "${API}/accounts/${ACC}/oauth_clients" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${CREATE_BODY}")

if [ "$(echo "$RESP" | jq -r '.success')" != "true" ]; then
  echo "!! OAuth client creation FAILED:"
  echo "$RESP" | jq .
  echo "   If this is a 403 / code 10000, the token lacks 'OAuth Client Write'."
  exit 1
fi

CLIENT_ID=$(echo "$RESP" | jq -r '.result.client_id')
CLIENT_SECRET=$(echo "$RESP" | jq -r '.result.client_secret')
echo ">> Created client_id=${CLIENT_ID} (secret returned once, installing now)"

set_secret() {
  local name="$1" value="$2"
  local out
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

echo ">> DONE. Now click Connect on the Cloudflare gatekeeper and verify the OAuth flow live."
