# gatekeeper-etsy

A CloudflareOS Gatekeeper for the Etsy shop `lindanahandmade` (OWL-1748). It mediates all access
between Gadgets/agents and the Etsy Open API v3, following the `write-gatekeeper` skill.

## Grant levels

Two independently grantable resource types (`getSupportedResources`):

- **Etsy Shop** — `https://www.etsy.com/shop/:shopName` → `EtsyShop` session. Read shop metadata,
  browse listings/orders/reviews, and open a single listing or order.
- **Etsy Listing** — `https://www.etsy.com/listing/:listingId` → `EtsyListing` session. Read and edit
  one product.

Orders (`EtsyReceipt`) are reached only through a shop handle; a per-order grant is not a useful unit.

## Scope (Phase 1)

This is Phase 1 of the skill (responsibilities 1–3):

1. **Auth** — OAuth 2.0 + PKCE. Tokens are stored, refreshed and rotated (single-flight) in the
   `UserAccount` Durable Object. Etsy rotates the refresh token on every refresh, so the new value is
   always persisted.
2. **Capability API** — `GatekeeperVendor` / `GatekeeperUserImpl` / `EtsyGatekeeperImpl` +
   `SessionImpl`s exposing the approved `src/types.d.ts` interfaces. `getGatekeeperClassFor()` maps
   shop and listing URLs to the DO class.
3. **Fine-grained granting** — resource-configurator iframes (`src/configurator/`) to pick a shop or
   a listing.

Writes go through the platform `ApprovalQueue` (`submitAction` / `applyAction`); reads call
`authorizeObservation`. Reads are **not** simulated yet, so submitted actions carry `awaitDecision`.

**Phase 2** (not in this PR): full observer strategy, approval-logging depth, caching, and simulation.
Observer methods here are the minimal strategy-B form (single-unit shop ACL).

## Fixed decisions

- Shop: `lindanahandmade`; shop id resolved via `GET /v3/application/shops?shop_name=…` (key only).
- Scopes: `shops_r listings_r transactions_r listings_w transactions_w` (OWL-1740 sign-off).
- Price and quantity are **read-only** (`updateListingInventory` is out of scope).

## Configuration

Secrets (see `deploy-inputs.json`): `ETSY_KEYSTRING` (app API key; `x-api-key` + OAuth client id),
optionally `ETSY_SHARED_SECRET`. `ETSY_SHOP` / `ETSY_API_BASE` / `BASE_URL` are optional overrides.

Registered in the root `wrangler.jsonc` as
`{ "binding": "GATEKEEPER_ETSY", "service": "cloudflareos-gk-etsy" }`. **Not deployed in this PR.**
