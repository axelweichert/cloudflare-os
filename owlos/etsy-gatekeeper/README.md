# gatekeeper-etsy (OWL-1740 · Elternticket OWL-1739)

Etsy-Shop **lesen & schreiben mit Human-in-the-Loop-Approval**. Agenten *lesen* Shop-, Listing-,
Bestell- und Bewertungsdaten direkt (read-only, gefahrlos); jede **Schreibaktion** (Listing- oder
Bestell-Update) wird als Vorschlag in eine Freigabe-Queue gelegt und erst nach menschlicher
Bestätigung (hinter CF Access) real gegen die **Etsy Open API v3** (`https://openapi.etsy.com`)
ausgeführt. So kann der owlOS-Agent den Etsy-Shop bedienen, ohne ungeprüft zu schreiben.

Struktur analog zu `owlos/crm-gatekeeper`: schlank, self-contained, workerd-nativ, kein Fremd-Code.

## Architektur

```
Agent ──/mcp──▶ get_*/list_*        ──▶ Etsy Open API v3 (GET)                     [direkt]
Agent ──/mcp──▶ propose_* (update)  ──▶ [pending] ── Durable Object (Schreib-Queue) ──┐
                                                                                       │
Mensch ─GET / (CF Access)─▶ Freigabe-UI ─POST /api/queue/:id/approve ─▶ Etsy PATCH/PUT ─▶ [applied]
                                          ─POST /api/queue/:id/reject  ─▶                  [rejected]
```

- **`write-queue.ts`** — reiner Statemachine-Kern: `pending → approved → applied|failed` bzw.
  `pending → rejected`. Erzwingt Ziel- & Op-Allowlist, **Feld-Allowlist pro Ziel** mit Typ-/Enum-
  Check, Primitive-Werte, numerische `targetId`, keine Doppel-Entscheidung (Race-sicher). Speicher-agnostisch.
- **`token-store.ts`** — **OAuth-2.0-Token-Lifecycle**: Refresh gegen `api.etsy.com`, Persistenz des
  **rotierenden** Refresh-Tokens (KV in Prod, Memory in Tests), Skew-Puffer, Single-Flight. Der
  häufigste Betriebsausfall — deshalb zentral und voll testabgedeckt.
- **`etsy-client.ts`** — Etsy-Datenzugriff. Reads direkt, Writes nur über freigegebene `WriteAction`.
  `x-api-key` auf jedem Request, OAuth-Bearer für private/schreibende Endpoints, **429-Behandlung**
  (klarer Fehler ans MCP, **keine stille Retry-Schleife**), Pfade aus statischen Templates + numerisch
  geprüften IDs, Query/Body ausschließlich über `URLSearchParams`.
- **`mcp-server.ts`** — Streamable-HTTP-MCP. Lese-Tools direkt, `propose_*`-Tools queued.
- **`ui.ts`** — SSR-HTML-Freigabeseite (kein Build, keine Client-Deps), zeigt Feld-Diff.
- **`worker.ts`** — DO `EtsyGatekeeper` (Singleton `default`) + HTTP-Routing + Token-Wiring + Write-Ausführung.

## Tools (MCP)

| Tool | Art | Zweck | Scope |
|---|---|---|---|
| `get_shop` | Lesen (direkt) | Shop-Stammdaten | `x-api-key` |
| `list_listings` / `get_listing` | Lesen (direkt) | Listings (opt. `state`) | `listings_r` / public |
| `get_listing_inventory` | Lesen (direkt) | Preise/Mengen/Offerings | `listings_r` |
| `list_receipts` | Lesen (direkt) | Bestellungen (opt. `wasPaid`/`wasShipped`) | `transactions_r` |
| `list_reviews` | Lesen (direkt) | Shop-Bewertungen | `x-api-key` |
| `propose_listing_update` | Schreiben (queued) | Listing ändern → `updateListing` (PATCH) | `listings_w` |
| `propose_receipt_update` | Schreiben (queued) | Bestellstatus → `updateShopReceipt` (PUT) | `transactions_w` |
| `list_my_proposals` | Lesen (direkt) | Status eigener Vorschläge | — |

Schreib-Tools nehmen `id` (numerische Etsy-ID), `fields` (Feld→Wert) und optional `reason`.
Erlaubte Felder (Allowlist, `write-queue.ts` `FIELD_ALLOWLIST`):

- **listing**: `title`, `description`, `state` (`active`\|`inactive`), `should_auto_renew`, `shop_section_id`
- **receipt**: `was_shipped`, `was_paid`

### Bewusste v1-Abgrenzung (Preis/Menge)

`propose_listing_update` deckt die flachen `updateListing`-Felder ab — inkl. `state`
(Aktivieren/Deaktivieren), dem operativ wichtigsten Schreibpfad. **Preis und Menge** liegen bei Etsy
**nicht** auf `updateListing`, sondern auf `updateListingInventory` mit einem verschachtelten
`products`-Payload. Dieser verschachtelte Payload widerspricht der Primitive-/Feld-Allowlist-
Invariante (dem Sicherheitsrückgrat des Gatekeepers) und ist deshalb **absichtlich nicht im v1-
Umfang**. Die Allowlist ist so gebaut, dass ein späteres Ziel `listing_inventory` eine kleine,
lokale Ergänzung wäre. (Ebenso bewusst weggelassen: Array-Felder `tags`/`materials`.)

## Routen

| Route | Methode | Wer | Zweck |
|---|---|---|---|
| `/mcp` | POST | Agent | MCP (Lesen direkt, Schreiben queued) — Auth via `API_KEY` (Bearer/`X-API-Key`) |
| `/` | GET | Mensch | HTML-Freigabe-UI |
| `/api/queue[?status=]` | GET | Mensch | JSON-Liste der Schreib-Vorschläge |
| `/api/queue/:id/approve` | POST | Mensch | freigeben → Etsy PATCH/PUT ausführen |
| `/api/queue/:id/reject` | POST | Mensch | ablehnen |
| `/api/token/seed` | POST | Mensch | initialen OAuth-Refresh-Token setzen (manueller Fallback) |
| `/api/token/status` | GET | Mensch | Token-Status ohne Geheimnisse (vorhanden? Ablauf?) |
| `/oauth/start` | GET | Mensch | PKCE-Authorize-Flow starten → 302 auf Etsys „Erlauben"-Seite |
| `/oauth/callback` | GET | Mensch (Redirect) | Etsy-Redirect: `state` prüfen, Code tauschen, Token ins KV |

Agenten-Identität aus `X-Agent-Id` (Fallback CF-Access-Email). Freigebender Mensch aus
`Cf-Access-Authenticated-User-Email`. **CF Access vor `/`, `/api/*` UND `/oauth/*` ist die einzige
menschliche Boundary — bei Deploy zwingend konfigurieren.** `/oauth/start` + `/oauth/callback` sind
ein **Wiring-Werkzeug für einen Menschen** (Shop-Inhaberin klickt „Erlauben"), kein öffentlicher
Endpunkt. Agenten an `/mcp` werden zusätzlich über den internen `API_KEY` authentifiziert.

### OAuth-Authorize-Flow (PKCE, `/oauth/start` + `/oauth/callback`)

Bequemer Weg zum initialen (rotierenden) Refresh-Token statt manuellem `/api/token/seed`:

- **`/oauth/start`** erzeugt ein PKCE-Paar (`code_verifier` kryptografisch zufällig, `code_challenge =
  base64url(SHA-256(verifier))`, `S256`), legt `code_verifier` + `state` **serverseitig im KV** ab
  (kurzlebig, TTL) und leitet per 302 auf Etsys Authorize-Seite mit exakt den abgenommenen Scopes um:
  `shops_r listings_r transactions_r listings_w transactions_w`.
- **`/oauth/callback`** prüft `state` (CSRF), tauscht Code + `code_verifier` gegen den Token-Endpoint
  und persistiert den Refresh-Token über denselben `TokenManager`/`KvTokenStore` wie der Refresh-Pfad.
- **Einmal-Charakter:** nach dem Tausch ist der `state` verbraucht; ein zweiter Callback schlägt fehl.
- **Kein Geheimnis** (`code_verifier`, Code, Token) landet je in URL oder Log.

`code_verifier`/`state` teilen sich das KV `ETSY_TOKENS` (eigener Key-Präfix `oauth:txn:`); es braucht
**kein zusätzliches Binding**.

## Sicherheitsmodell

- **Kein direkter Schreibpfad für Agenten.** `propose_*` legt nur `pending` an; der einzige Weg in den
  Etsy-Write führt über einen menschlichen `approve` hinter CF Access.
- **Feld-Allowlist + Typ/Enum pro Ziel**, doppelt geprüft in Queue **und** Client (Defense-in-depth).
  Pfade aus statischen Templates + numerisch validierten IDs; keine String-Interpolation von Nutzwerten.
- **Kein Doppel-Write.** Nur `pending` ist entscheidbar, nur `approved` ausführbar (idempotenz-sicher).
- **Token-Sicherheit.** Access/Refresh nur in KV (Secret-Bindung), nie im Repo. Rotierender Refresh-
  Token wird bei jedem Refresh persistiert. Bei `approve` schlägt ein toter Token als klarer Fehler
  fehl (Item → `failed`), statt still zu hängen.
- **429/Rate-Limits** werden als klarer Fehler mit `retryAfterSeconds` gemeldet — keine stille Retry-Schleife.

## Testen (workerd-frei)

```bash
npx tsx --test owlos/etsy-gatekeeper/write-queue.test.ts \
                owlos/etsy-gatekeeper/token-store.test.ts \
                owlos/etsy-gatekeeper/etsy-client.test.ts \
                owlos/etsy-gatekeeper/mcp-server.test.ts \
                owlos/etsy-gatekeeper/oauth.test.ts
# 65 Tests: Statemachine, Feld-Allowlist/Enum, Token-Refresh+Rotation+Single-Flight,
#           429-Handling, Write-Erzeugung (Fake-fetch), MCP-Flow,
#           OAuth-Authorize-Flow (PKCE-S256, state-CSRF + Einmal, Token-Tausch). KEIN Netzzugriff.
```

## Deploy (CEO-Wiring-Gate)

**Kein Deploy in diesem Ticket** — Deploy ist CEO-/Board-Gate; die Credentials existieren noch nicht.
Vor `wrangler deploy` müssen gesetzt werden:

1. **Konto-Grenze (Board-Regel OWL-1434) prüfen.** Ausschließlich unser CF-Account **Weichert.at**.
   Der Account `6d2a1d5945f8b63047a1d59a9f94de21` (von Busch) ist **tabu**. Vor jedem `wrangler`-
   Kommando die aktive `account_id` verifizieren. In `wrangler.jsonc` ist bewusst **keine** `account_id`
   gepinnt — sie wird beim Wiring aktiv gesetzt/geprüft.
2. **KV-Namespace** `ETSY_TOKENS` im Weichert.at-Account anlegen und die echte `id` in `wrangler.jsonc`
   eintragen (Platzhalter ersetzen).
3. **`ETSY_SHOP_ID`** (Var) auf die numerische Shop-ID der Shop-Inhaberin setzen.
4. **Secrets** setzen (nie ins Repo):
   ```bash
   wrangler secret put ETSY_KEYSTRING           # App-API-Key (keystring)
   wrangler secret put ETSY_SHARED_SECRET       # App-Shared-Secret
   wrangler secret put API_KEY                   # interner Agenten-API-Key für /mcp
   # initialer Refresh-Token — Variante A (Secret) ODER Variante B (Seed-Route, siehe unten):
   wrangler secret put ETSY_SEED_REFRESH_TOKEN   # optional
   ```
5. **OAuth-Grant** aus dem Etsy-Account der Shop-Inhaberin einholen (Authorization-Code-Flow mit PKCE)
   → Refresh-Token. Der Worker bringt den Flow als `/oauth/start` + `/oauth/callback` mit (siehe unten).
   Minimale **Scopes** (exakt diese, im Worker fest verdrahtet):
   - Lesen: `shops_r`, `listings_r`, `transactions_r`
   - Schreiben (nur soweit nötig): `listings_w` (Listing-State/Titel/…), `transactions_w` (Bestellstatus)
6. **CF Access** vor `/`, `/api/*` **und `/oauth/*`** (menschliche Boundary — auch der Authorize-Flow).

```bash
npx wrangler deploy -c owlos/etsy-gatekeeper/wrangler.jsonc
```

#### Callback-URL bei Etsy eintragen

Bei der Etsy-App-Registrierung ist eine **Redirect-URI** Pflicht. Sie hat exakt diese Form:

```
https://<worker-host>/oauth/callback
```

`<worker-host>` ist der öffentliche Host dieses Workers hinter CF Access (Custom-Domain oder
`gatekeeper-etsy.<subdomain>.workers.dev`) — genau der Host, unter dem `/` (die Freigabe-UI) läuft.
Die exakte URL steht erst nach dem Deploy fest und wird vom Board bei Etsy hinterlegt.

#### Ablauf (initiale Verbindung)

1. Worker **deployen** (Schritte 1–6 oben), CF Access aktiv.
2. **Callback-URL** `https://<worker-host>/oauth/callback` in der Etsy-App als Redirect-URI eintragen.
3. `https://<worker-host>/oauth/start` **im Browser öffnen** (CF-Access-Login) → 302 zu Etsy.
4. **Shop-Inhaberin klickt „Erlauben"** → Etsy leitet auf `/oauth/callback` zurück, der Worker tauscht
   den Code und legt den (rotierenden) Refresh-Token ins KV. Erfolgsseite = **fertig**.

`GET /api/token/status` zeigt danach den Ablauf ohne Geheimnisse. **Manueller Fallback** (bleibt
erhalten): hinter CF Access `POST /api/token/seed` mit `{"refreshToken":"<rotierender-refresh-token>"}`.

## Board-Abhängigkeit (blockiert NICHT den Bau)

Für den späteren **Live-Betrieb** braucht es vom Board:
1. Etsy-App-Registrierung (`keystring` + `shared_secret`),
2. OAuth-2.0-Grant der Shop-Inhaberin → Refresh-Token,
3. numerische Shop-ID.

Diese Werte holt der CEO parallel ein. **Bau und Tests laufen ohne sie vollständig durch** (Fake-fetch,
kein Netz). Der Referenz-Dev-MCP (`mcp.api.etsycloud.com`) ist Etsys Doku-Server (Endpoints/Schemas),
keine Live-Datenquelle — er wurde beim Bau für Endpoint-Details/Schemas genutzt, nicht geraten.
