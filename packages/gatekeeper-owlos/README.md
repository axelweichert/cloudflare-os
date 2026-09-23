# gatekeeper-owlos (OWL-1633 / OWL-1631 Teil B, S1)

Gatekeeper für die **owlOS Cloud-ERP-Fläche**: Kunden, Angebote/Aufträge, Rechnungen.
Token-Connect-Kachel (wie `gk-unifi` / `gk-cloudflare`). Live-Ziel: Worker
`cloudflareos-gk-owlos` im **Weichert.at**-Account (`6b9b3fa0…`), Binding `GATEKEEPER_OWLOS`
auf Backend + Router.

## Warum kein externer API-Call (das war der falsche Blocker)

Frühere Runs blockten OWL-1633 mit „es gibt keine owlOS-ERP-API, also nicht baubar". **Das
war falsch.** Das Repo enthält bereits ein **shipped, self-backed** Gatekeeper-Muster:
`vonbusch/crm-gatekeeper` speichert seine CRM-Daten in **eigenem D1** und ruft keine externe
CRM-API — der Token gated nur den Zugriff. owlOS ERP folgt exakt diesem Muster: **der
Gatekeeper IST das ERP-Backend** (self-backed D1 `owlos-erp`). Es braucht deshalb **keine
fremde API-Doku vom Board** — der Treiber ist ohne externe Referenz baubar.

## Architektur

```
Gadget/Agent ──RPC──▶ OwlosSession (Vendor→User→Instance)
                          │  read  ▶ D1 SELECT (parametrisiert, LIMIT-Cap)      [direkt]
                          │  write ▶ Angebot/Rechnung anlegen (Approval-Queue*)
Mensch ─Token-Connect-Kachel─▶ Workspace-API-Token → UserAccount-DO (credentials)
```

- **`src/owlos-store.ts`** — self-backed ERP-Store. `MemoryOwlosStore` (Tests) +
  `D1OwlosStore` (parametrisiert, Spalten nur aus statischer Allowlist, LIMIT-Caps).
  `validateWrite()` erzwingt Entity-/Op-/Spalten-Allowlist (Injection-Schutz).
- **`src/types.d.ts`** — `OwlosSession`: die agenten-sichtbare API der 3 Blueprints.
- **`schema.sql`** — D1-Schema (kunden / angebote / rechnungen). Source-of-Truth.
- **`src/owlos.ts`** — *(Phase 2)* Vendor/UserAccount/UserImpl/GatekeeperImpl/SessionImpl +
  Token-Connect-HTTP-Flow (Muster: `gk-cloudflare` nach OWL-1618, Formular statt OAuth).

\* Approval-Queue (Human-in-the-Loop für Schreibaktionen) wie in `crm-gatekeeper` — in Phase 2.

## Die 3 Blueprints (OWL-1631, board-approved)

| Blueprint | OwlosSession-Methoden |
|---|---|
| Angebot/Auftrag anlegen | `createAngebot`, `setAngebotStatus` (`auftrag`\|`storniert`) |
| Rechnung erzeugen | `createRechnung` |
| Kunde + offene Posten lesen | `listKunden`, `getKunde`, `listOffenePosten` (Rechnung status `offen`) |

## Test (workerd-frei)

```bash
node --import tsx --test packages/gatekeeper-owlos/src/owlos-store.test.ts
```

## Deploy / Wiring (Weichert.at, account_id 6b9b3fa0…)

1. D1 provisionieren: `wrangler d1 create owlos-erp` → `database_id` in `wrangler.jsonc`.
2. Schema laden: `wrangler d1 execute owlos-erp --file packages/gatekeeper-owlos/schema.sql`.
3. `wrangler deploy -c packages/gatekeeper-owlos/wrangler.jsonc` (Name `cloudflareos-gk-owlos`).
4. Binding `GATEKEEPER_OWLOS` (service `cloudflareos-gk-owlos`, entrypoint `GatekeeperVendor`)
   auf **Backend + Router** — via Settings-PATCH (bindings-erhaltend, wie bei allen 18 GK).
5. Live-Beleg: Kachel „owlOS" sichtbar, Token-Connect-Formular akzeptiert Workspace-Token.

> account_id-Grenze: ausschließlich Weichert.at `6b9b3fa0e9f6be87faf7ca1b212641a3`.
> Der tabu von-Busch-Account (`6d2a1d59…`) wird nie berührt.

## Status

- **Phase 1 (dieser Stand):** Session-API-Contract + self-backed Store + Schema + Tests. ✅
- **Phase 2 (offen, Owner Founding Engineer):** `owlos.ts` RPC-Scaffold (Vendor/User/Session)
  + Token-Connect-Flow + Approval-Queue → deploy Weichert.at → wire `GATEKEEPER_OWLOS` →
  Live-Kachel bewiesen.
