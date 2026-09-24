# gatekeeper-owlos (OWL-1641 / OWL-1633 S1)

Token-Connect gatekeeper for **owlOS Cloud ERP** (https://owl-os.cloud) — a real, edge-native ERP.
Live target: Worker `cloudflareos-gk-owlos` in the **Weichert.at** account (`6b9b3fa0…`), binding
`GATEKEEPER_OWLOS` on backend + router.

## owlOS is a real, per-tenant HTTP API (verified live)

owlOS is **not** self-backed. Each customer runs their **own** owlOS instance in their **own**
Cloudflare account — there is no central `api.owl-os.cloud` host. Verified against the public demo
(`demo.owl-os.cloud`, OWL-1641):

- `GET /api/health` is public → `{"ok":true,"app":"owlos-cloud-erp","version":"…","env":"production"}`
- The auth middleware runs **before** routing: every `/api/*` (even a made-up path) returns
  `401 {"error":"unauthorized"}` unauthenticated — so a 401 on an arbitrary path proves nothing.
- `GET /api/auth/me` is whitelisted from that catch-all: unauthenticated it returns the distinct
  `401 {"authenticated":false}`. It is the real identity endpoint the owlOS SPA itself polls, so it
  is the correct `401→200` probe (**not** `/api/me`, which is just the catch-all).

Because the instance is per-tenant, the connect form collects **instance URL + API token** (like
`gk-unifi`, not just a token). The API base is `{instanceUrl}/api`.

## Connect + verify (S1)

Same nonce-protected connect flow as `gk-unifi`/`gk-cloudflare`. On submit, `verifyCredentials`:

1. `GET {base}/api/health` — must report `app === "owlos-cloud-erp"` (real, reachable owlOS).
2. `GET {base}/api/auth/me` — must go 401→200 to prove the token.

Only then are the credentials stored in the `UserAccount` DO.

### Auth header: probed, not guessed

The live owlOS SPA authenticates with **email+password → session cookie** (`credentials:"include"`);
no self-service API-token screen is visible in the live customer app, and no demo token could be
minted headless to read back the exact header. Rather than guess `Authorization: Bearer` vs
`X-API-Key`, `verifyCredentials` **probes both against the live instance** and persists whichever the
instance answers `200` to — it never stores a scheme it did not see accepted.

> **OPEN (OWL-1647 blocker):** whether owlOS grants API access via a *header* token at all (vs
> cookie-only) is unconfirmed until a real token exists. The owlOS owner supplying **one** valid
> token resolves both the header scheme and this question live. S2 (OWL-1634) then pins the confirmed
> scheme + endpoints.

## Scope

S1 ships the driver + connect + verify and exposes the authenticated workspace identity
(`OwlosSession.me()`). The full blueprint surface — customers, quotes/orders (Angebote/Aufträge),
invoices (Rechnungen) CRUD — is wired in **S2 (OWL-1634)** and extends `OwlosSession`.

## Files

| File | Purpose |
| --- | --- |
| `src/owlos.ts` | Worker: connect form, `GatekeeperVendor`, `UserAccount` DO, `OwlosUserImpl`, `OwlosGatekeeperImpl`, session. |
| `src/owlos-api.ts` | HTTP driver: `normalizeInstanceUrl`, `verifyCredentials`, `OwlosClient`. |
| `src/types.d.ts` / `src/types.txt` | Agent-facing session types (`.d.ts` for `tsc`, `.txt` imported as the runtime string). |
| `wrangler.jsonc` | Worker config (DO migrations: `UserAccount`, `OwlosGatekeeperImpl`). |
