# gatekeeper-owlos (OWL-1641 / OWL-1633 S1)

Token-Connect gatekeeper for **owlOS Cloud ERP** (https://owl-os.cloud) — a real, edge-native ERP.
Live target: Worker `cloudflareos-gk-owlos` in the **Weichert.at** account (`6b9b3fa0…`), binding
`GATEKEEPER_OWLOS` on backend + router.

## owlOS is a real, per-tenant HTTP API (verified live)

owlOS is **not** self-backed. Each customer runs their **own** owlOS instance in their **own**
Cloudflare account — there is no central `api.owl-os.cloud` host. Verified against the public demo
(`demo.owl-os.cloud`, OWL-1641):

- `GET /api/health` is public → `{"ok":true,"app":"owlos-cloud-erp","version":"…","env":"production"}`
- every other `/api/*` without a token → `401 {"error":"unauthorized"}`

Because the instance is per-tenant, the connect form collects **instance URL + API token** (like
`gk-unifi`, not just a token). The API base is `{instanceUrl}/api`.

## Connect + verify (S1)

Same nonce-protected connect flow as `gk-unifi`/`gk-cloudflare`. On submit, `verifyCredentials`:

1. `GET {base}/api/health` — must report `app === "owlos-cloud-erp"` (real, reachable owlOS).
2. `GET {base}/api/me` — must go 401→200 to prove the token.

Only then are the credentials stored in the `UserAccount` DO.

### Auth header: probed, not guessed

The demo's browser UI is behind Cloudflare Access, so a demo token could not be minted from a
headless build to read back the exact header. Rather than guess `Authorization: Bearer` vs
`X-API-Key`, `verifyCredentials` **probes both against the live instance** and persists whichever the
instance answers `200` to — it never stores a scheme it did not see accepted. S2 (OWL-1634) pins the
confirmed scheme once a real token exists.

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
