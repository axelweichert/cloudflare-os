# gatekeeper-vonbusch-crm (K2-Port, VON-1817)

Portiert den eigenständigen MCP-Baustein `vonbusch/crm-gatekeeper` (VON-1800) auf die
CloudflareOS-`GatekeeperVendor`-Gadget-Schnittstelle. Damit erscheint das vonBusch-CRM
(`vonbusch-crm-eu`) als **Kachel im bestehenden CloudflareOS-Deploy** — kein neuer Deploy, kein
zweites Projekt. Leitfaden: `vonbusch/PORTING-GATEKEEPERVENDOR.md`.

## Was das Gadget kann

Ressource: `https://crm.vonbusch.app/` (interner, auto-provisionierter Account — kein OAuth).
Session-Typ `Crm` (siehe `getTypeScriptTypes()`):

| Methode | Art | Wirkung |
|---|---|---|
| `listContacts(opts?)` | Read | Kontakte (Freitextsuche, LIMIT-Cap 200) |
| `getContact(id)` | Read | ein Kontakt |
| `listDeals(opts?)` | Read | Deals (opt. `contactId`-Filter) |
| `listActivities(opts?)` | Read | Aktivitäten (opt. `contactId`-Filter) |
| `proposeContact(input)` | Write | Kontakt anlegen/ändern — **queued** |
| `proposeDeal(input)` | Write | Deal anlegen/ändern — **queued** |
| `proposeActivity(input)` | Write | Aktivität anlegen/ändern — **queued** |

Erlaubte Spalten (Allowlist, alles andere wird abgelehnt):

- **contact:** `name, email, phone, company, status, owner, notes`
- **deal:** `title, contact_id, value, stage, status, owner, close_date, notes`
- **activity:** `contact_id, deal_id, type, subject, body, status, owner, due_at`

## Approval-Modell (Human-in-the-Loop)

- **Reads** sind read-only und laufen sofort — jede Rückgabe wird zuvor über
  `approvalQueue.authorizeObservation()` autorisiert und auditiert.
- **Writes** werden NIE direkt ausgeführt: `proposeXxx()` validiert (Entity, Op, Allowlist,
  Primitive, LIMIT/Längen-Caps) und reiht die Aktion über `approvalQueue.submitAction()` ein.
  Erst nach menschlicher Freigabe ruft der Overseer `CrmGatekeeper.applyAction()`, das die
  **parametrisierte** D1-Mutation gegen `vonbusch-crm-eu` ausführt (Spalten-Allowlist erneut,
  Werte nur als gebundene `?`-Parameter, `applyAction` ist idempotent → kein Doppel-Write).
- `getAutoApprovableActions()` ist **leer** — CRM-Schreibaktionen (`vonbusch.crm.write`) sind nie
  auto-approvable, weil sie Kundendaten verändern.
- Das CRM trägt kein per-Datensatz-ACL; **CF Access** bleibt — wie im Ursprungs-Baustein — die
  Zugangsboundary. `addObserver` merkt Beobachter vor.

## Architektur

- `src/crm-actions.ts` — Schreibaktions-Typen + `validateAction` (aus write-queue.ts; die alte
  `WriteApprovalQueue` ist im OS-Port durch die OS-`ApprovalQueue` ersetzt).
- `src/crm-store.ts` — `MemoryCrmStore` (Tests) + `D1CrmStore` (parametrisiert). 1:1 portiert.
- `src/session-core.ts` — transport-freier `CrmSessionCore` (Reads→authorize, Writes→enqueue) +
  `applyCrmAction`. Workerd-frei, `tsx`-testbar.
- `src/crm-gatekeeper.ts` — Worker-Entry: `GatekeeperVendor` / `CrmAccount` / `CrmVerifier` /
  `CrmGatekeeper` (DO) / `CrmSessionRpc`.

## Verifikation (ohne Live-Bind)

```
# Tests (workerd-frei) — 31 grün
node --import tsx --test test/*.test.ts
# Typecheck
wrangler types && tsc --noEmit -p tsconfig.json
# Bundle
wrangler deploy --dry-run
```

## Wiring & Deploy-Gate (CEO)

Das Backend entdeckt dieses Package **automatisch**: `scripts/run-dev-server.ts` (dev) bzw.
`generate-wrangler-prod.js` (prod) scannen `packages/gatekeeper-*` und ergänzen dynamisch das
Service-Binding `GATEKEEPER_VONBUSCH_CRM → gatekeeper-vonbusch-crm` am `workshop-backend`. Es ist
**keine** manuelle Backend-Konfig-Änderung nötig.

Für den Live-Bind (NFR-Account `6d2a1d59…`, Board-Gate) fehlt nur:

1. Echte `database_id` von `vonbusch-crm-eu` in `wrangler.jsonc` (Platzhalter
   `REPLACE_WITH_VONBUSCH_CRM_EU_ID`).
2. `wrangler deploy` des Workers auf den NFR-Account (Teil des bestehenden CloudflareOS-Deploys).

Es werden **keine** Schreib-Credentials benötigt: die einzige Schreibgewalt ist der menschliche
Approve-Pfad (OS-`ApprovalQueue` → `applyAction`).
