# gatekeeper-vonbusch-crm (VON-1800 / K2)

CRM **Lesen & Schreiben mit Human-in-the-Loop-Approval**. Agenten/Gadgets *lesen* Kontakte,
Deals und Aktivitäten direkt (read-only, gefahrlos); jede **Schreibaktion** (create/update)
wird als Vorschlag in eine Freigabe-Queue gelegt und erst nach menschlicher Bestätigung (hinter
CF Access) real gegen `vonbusch-crm-eu` (D1) ausgeführt. So können Vertriebs-Dashboard-Gadgets
pro Kunde CRM-Daten anzeigen und Änderungen *vorschlagen*, ohne ungeprüft zu schreiben.

Analog zu `mail-gatekeeper` (K5) und `preiserhebung-gatekeeper` (K1): schlank (Aufwand M),
self-contained, workerd-nativ.

## Architektur

```
Agent ──/mcp──▶ list_*/get_*        ──▶ D1 SELECT (parametrisiert, LIMIT-Cap)   [direkt]
Agent ──/mcp──▶ propose_* (create/update) ──▶ [pending] ── Durable Object (Schreib-Queue) ──┐
                                                                                             │
Mensch ─GET / (CF Access)─▶ Freigabe-UI ─POST /api/queue/:id/approve ─▶ D1 INSERT/UPDATE ─▶ [applied]
                                          ─POST /api/queue/:id/reject  ─▶                    [rejected]
```

- **`write-queue.ts`** — reiner Statemachine-Kern: `pending → approved → applied|failed` bzw.
  `pending → rejected`. Erzwingt Entity- & Op-Allowlist, **Spalten-Allowlist pro Entity**,
  Primitive-Werte, `update`⇒`targetId`, keine Doppel-Entscheidung (Race-sicher). Speicher-agnostisch.
- **`crm-store.ts`** — CRM-Datenzugriff. `MemoryCrmStore` (Tests) und `D1CrmStore`
  (parametrisiert, Spalten nur aus statischer Allowlist, Tabellennamen statisch gemappt,
  LIMIT-Caps gegen Runaway-Reads). Reads direkt, Writes nur über freigegebene `WriteAction`.
- **`mcp-server.ts`** — Streamable-HTTP-MCP. Lese-Tools direkt, `propose_*`-Tools queued.
- **`ui.ts`** — SSR-HTML-Freigabeseite (kein Build, keine Client-Deps), zeigt Feld-Diff.
- **`worker.ts`** — DO `CrmGatekeeper` (Singleton `default`) + HTTP-Routing + D1-Ausführung.

## Tools (MCP)

| Tool | Art | Zweck |
|---|---|---|
| `list_contacts` / `get_contact` | Lesen (direkt) | Kontakte |
| `list_deals` / `list_activities` | Lesen (direkt) | Deals / Aktivitäten (opt. je `contactId`) |
| `propose_contact` / `propose_deal` / `propose_activity` | Schreiben (queued) | create/update-Vorschlag |
| `list_my_proposals` | Lesen (direkt) | Status eigener Vorschläge |

Schreib-Tools nehmen `op` (`create`\|`update`), bei update `id`, und `fields` (Spalte→Wert).
Erlaubte Spalten (Allowlist, siehe `write-queue.ts` `COLUMN_ALLOWLIST`):

- **contact**: name, email, phone, company, status, owner, notes
- **deal**: title, contact_id, value, stage, status, owner, close_date, notes
- **activity**: contact_id, deal_id, type, subject, body, status, owner, due_at

## Routen

| Route | Methode | Wer | Zweck |
|---|---|---|---|
| `/mcp` | POST | Agent | MCP (Lesen direkt, Schreiben queued) — Auth via `API_KEY` (Bearer/`X-API-Key`) |
| `/` | GET | Mensch | HTML-Freigabe-UI |
| `/api/queue[?status=]` | GET | Mensch | JSON-Liste der Schreib-Vorschläge |
| `/api/queue/:id/approve` | POST | Mensch | freigeben → D1-Mutation ausführen |
| `/api/queue/:id/reject` | POST | Mensch | ablehnen |

Agenten-Identität aus `X-Agent-Id` (Fallback CF-Access-Email). Freigebender Mensch aus
`Cf-Access-Authenticated-User-Email`. **CF Access vor `/` und `/api/*` ist die einzige
menschliche Boundary — bei Deploy zwingend konfigurieren.** Agenten an `/mcp` werden zusätzlich
über den internen `API_KEY` authentifiziert.

## Sicherheitsmodell

- **Kein direkter Schreibpfad für Agenten.** `propose_*` legt nur `pending` an; der einzige Weg
  in die D1-Mutation führt über einen menschlichen `approve` hinter CF Access.
- **Keine SQL-Injection über Spalten/Tabellen.** Spaltennamen kommen ausschließlich aus der
  statischen Allowlist, Tabellennamen aus einem statischen Mapping; alle Nutzwerte sind
  gebundene Parameter (`?`). Doppelte Allowlist-Prüfung in Queue **und** Store (Defense-in-depth).
- **Kein Doppel-Write.** Nur `pending` ist entscheidbar, nur `approved` ausführbar (idempotenz-sicher).
- **LIMIT-Caps** (Default 50, max 200) gegen Runaway-Reads.

## Testen (workerd-frei)

```bash
npx tsx --test vonbusch/crm-gatekeeper/write-queue.test.ts \
                vonbusch/crm-gatekeeper/crm-store.test.ts \
                vonbusch/crm-gatekeeper/mcp-server.test.ts
# 37 Tests: Statemachine, Allowlists, Injection-Schutz, Doppel-Write-Schutz,
#           D1-SQL-Erzeugung (Fake-D1), MCP-Flow.
```

## Lokal / E2E (Miniflare D1)

```bash
# schema.sql in lokale D1 laden und dev starten:
sed 's/REPLACE_WITH_VONBUSCH_CRM_EU_ID/00000000-0000-0000-0000-000000000000/' \
  vonbusch/crm-gatekeeper/wrangler.jsonc > /tmp/crm.e2e.jsonc
npx wrangler d1 execute CRM_DB --local -c /tmp/crm.e2e.jsonc --file vonbusch/crm-gatekeeper/schema.sql
npx wrangler dev -c /tmp/crm.e2e.jsonc --port 8788 --local
# 1) read:     POST /mcp tools/call list_contacts {search}
# 2) propose:  POST /mcp tools/call propose_contact {op:"create", fields:{...}}  → pending (KEIN Write)
# 3) approve:  POST /api/queue/<id>/approve  → D1 INSERT, status "applied"
# 4) read:     Datensatz jetzt sichtbar; Doppel-Approve → 409; unerlaubte Spalte → isError
```
Verifiziert: read-direkt, propose-schreibt-nicht, approve→realer D1-INSERT→applied,
Doppel-Approve→409, unerlaubte Spalte→isError. `schema.sql` ist NUR für die lokale E2E —
Prod nutzt die echten `vonbusch-crm-eu`-Tabellen.

## Deploy (CEO-Wiring-Gate)

Vor `wrangler deploy` müssen gesetzt werden:

1. **Echte `database_id`** von `vonbusch-crm-eu` in `wrangler.jsonc` (Platzhalter ersetzen).
2. **`wrangler secret put API_KEY`** — interner Agenten-API-Key für `/mcp`.
3. **CF Access** vor `/` und `/api/*` (menschliche Freigabe-Boundary).
4. **Spalten-Mapping prüfen:** die Allowlist in `write-queue.ts` gegen das reale
   `vonbusch-crm-eu`-Schema abgleichen (CRM-Repo). Bei abweichenden Spaltennamen dort anpassen.

```bash
npx wrangler deploy -c vonbusch/crm-gatekeeper/wrangler.jsonc
```

> Hinweis: Der Issue nennt zusätzlich „ANTHROPIC via AI-Gateway" für spätere Dashboard-Gadgets
> (Zusammenfassungen/Empfehlungen pro Kunde). Der Gatekeeper-Kern (CRUD + Approval) ist davon
> unabhängig; eine AI-Gateway-Bindung kann später als eigenes Gadget ergänzt werden.
