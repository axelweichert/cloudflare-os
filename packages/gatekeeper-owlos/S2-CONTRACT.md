# owlOS S2 blueprint contract (Kunde / Angebot / Rechnung)

**Authoritative. Do NOT guess owlOS endpoints (RATEN VERBOTEN).** Every path below was
extracted on 2026-09-23 from the *public* owlOS SPA bundle
`https://demo.owl-os.cloud/assets/index-*.js` (served without auth) — i.e. the real routes the
owlOS frontend itself calls, not a web-sourced or invented spec. Re-verify against the bundle if
owlOS ships a new version; the health probe reports the running version at `/api/health`.

## Ground truth

- Instance is per-tenant; API base = `{instanceUrl}/api`. `GET /api/health` is public and returns
  `{ok, app:"owlos-cloud-erp", version, env}`. demo is now **0.32.84** (was 0.32.80).
- Auth middleware runs *before* routing → every `/api/*` is `401 {"error":"unauthorized"}`
  unauthenticated, except `/api/health` and `/api/auth/me` (identity probe).
- **Self-service API tokens exist:** `GET /api/tokens → {tokens:[…]}`, `POST /api/tokens {name} →
  {token}`. This kills the old "no token issuance / header-auth unconfirmed" open item — header
  tokens are a first-class owlOS feature (Settings → Tokens). The connect driver already probes
  Bearer vs X-API-Key and persists only the accepted scheme (see `owlos-api.ts`), so the header
  name is still never guessed.

## The three blueprints

| Blueprint | Read (list) | Create | Minimal create body (from SPA) |
|---|---|---|---|
| **Kunde** (company) | `GET /api/companies` | `POST /api/companies` | `{name, …}`; assign number via `POST /api/companies/assign-kundennr` |
| **Angebot** (quote) | `GET /api/erp/quotes` | `POST /api/erp/quotes` | `{title}` **required** ("Titel ist Pflicht"); then `PATCH /api/erp/quotes/{id}` sets `company_id`, `status`, `valid_until` |
| **Rechnung** (outgoing invoice) | `GET /api/faktura/outgoing` | `POST /api/faktura/outgoing` | invoice header (`doc_type` defaults to invoice; `credit_note` variant); line items via `POST /api/faktura/outgoing/{id}/items`; commit via `POST /api/faktura/outgoing/{id}/finalize` |

Related read-only context the create flows may want: `GET /api/contacts`, `GET /api/erp/offers`,
`GET /api/faktura/opos`, `POST /api/erp/quotes/{id}/create-invoice` (quote → invoice).

## Build pattern (mirror `vonbusch/format-blueprints/`)

Each blueprint = one bundled format-blueprint gadget wired to the **existing** `owlos` gatekeeper
as a `spawnerOnly` binding (the `owlos` gatekeeper + `GATEKEEPER_OWLOS` on backend+router are
already deployed+wired from S1/OWL-1647 — S2 adds no new binding). Gadget shell + curated German
workflow prompt; the spawned agent reads/creates via `env.owlos` against the endpoints above.
Reads direct, creates approval-gated (same posture as the vonbusch CRM blueprint).

## Deploy + prove

- S2 is code/content only (blueprints bundled into the worker) → PR → `main` → Workers Builds
  auto-deploy. No manual `wrangler`/token, no bindings PATCH.
- **account_id HARD rule:** anything touching Cloudflare stays in Weichert.at `6b9b3fa0…`. Any
  other id → stop, block, notify CTO.
- Live proof = board clicks "Angebot anlegen" in User-Chrome against the owlOS instance it already
  connected in S1 (usage, not approval).
