# OWL-1740 — Security-Review (CTO-Gate): `gatekeeper-etsy` (PR #28)

**Status:** Gate **BESTANDEN**. Merge-Freigabe erteilt. **Kein Deploy** (CEO-/Board-Wiring-Gate, Credentials existieren noch nicht).

**Reviewer:** CTO · **Datum:** 2026-09-30 · **Scope:** `owlos/etsy-gatekeeper/` (Worker `gatekeeper-etsy`), Branch `owl-1740-etsy-gatekeeper`, PR #28.

Präzedenz: analog zum Stufe-4-Gate `docs/owlos/VON-1798-security-review.md`. Der Gatekeeper-Security-Review ist Haus-intern CTO-Sache; CISO nur bei einem Befund hinzuziehen — es gibt keinen.

---

## 1. Auftrag (aus OWL-1741 / Plan)

PR #28 abnehmen oder Änderungen anfordern; Security-Sign-off als CTO-Gate. Prüfpunkte: (1) Auth-/Approval-Pfad, (2) Token-Store-Rotation, (3) Feld-Allowlist, (4) 429-Behandlung, (5) CF Access als menschliche Boundary. Board-Regel OWL-1434 (fremde Accounts) wahren.

## 2. Befund (code-belegt)

**Alle fünf Prüfpunkte sauber. Kein direkter Schreibpfad für Agenten.**

1. **Auth-/Approval-Pfad — kein Agenten-Schreibpfad.** `propose_*` legt ausschließlich `pending` an (`mcp-server.ts:143-165`); der einzige Weg in einen Etsy-Write führt über `handleDecision(... "approve")` im Worker (`worker.ts:159-184`), der `Cf-Access-Authenticated-User-Email` als Entscheider verlangt. Die Statemachine ist race-/doppel-write-sicher: nur `pending` ist entscheidbar (`write-queue.ts:213`), nur `approved` ausführbar (`write-queue.ts:233,245`), Entscheidung ist idempotent. Ein zweiter `approve` auf dasselbe Item scheitert (`409`), Test „Doppel-Entscheidung wird verhindert" grün.

2. **Token-Store-Rotation — kein Verlust des gültigen Refresh-Tokens.** `doRefresh()` persistiert den rotierten Token **nur bei Erfolg** (`token-store.ts:144-151`); jeder Fehlerpfad (Netz, non-2xx, kaputtes JSON, unvollständige Antwort) wirft `TokenRefreshError` und lässt den vorhandenen Token unangetastet (`token-store.ts:122-142`). Single-Flight (`token-store.ts:101-106`) verhindert konkurrierende Refreshes, die einander invalidieren — und ist hier **wirksam**, weil der `TokenManager` im **Singleton-DO** lebt (`worker.ts:69-89`, Routing `idFromName("default")` in `worker.ts:230`): alle Requests laufen durch **eine** Instanz, es gibt keine Cross-Isolate-Rennbahn. Skew-Puffer (Default 60s) refresht vorzeitig (`token-store.ts:83`).

3. **Feld-Allowlist — kein Umgehungspfad.** `FIELD_ALLOWLIST` (`write-queue.ts:47-59`) mit Typ-/Enum-/Längen-Check pro Feld (`checkValue`, `write-queue.ts:105-120`); Werte nur Primitive (Objekte/Arrays abgelehnt, `write-queue.ts:146,166`); `targetId` numerisch erzwungen (`write-queue.ts:142`). **Doppelt geprüft** (Defense-in-depth): der Client filtert bei Ausführung erneut gegen dieselbe Allowlist (`etsy-client.ts:183-191`). Pfade werden aus **statischen Templates + numerisch geprüften IDs** gebaut (`etsy-client.ts:91-94,207-214`), Body ausschließlich über `URLSearchParams` — keine String-Interpolation von Nutzwerten.

4. **429-Behandlung — klarer Fehler, keine stille Retry-Schleife.** `handle()` wirft `EtsyRateLimitError` mit `retryAfterSeconds` (`etsy-client.ts:120-128`); `mcp-server.ts:167-173` übersetzt das in eine `isError`-Antwort ans MCP. Kein interner Retry.

5. **CF Access — als Deploy-Pflicht dokumentiert.** README benennt CF Access vor `/` und `/api/*` als „die einzige menschliche Boundary — bei Deploy zwingend konfigurieren" (`README.md:77-78`) und als Deploy-Schritt 6 (`README.md:128`). `/api/token/status` gibt keine Geheimnisse preis (`worker.ts:203-213`). Agenten an `/mcp` zusätzlich über internen `API_KEY` (`worker.ts:130-138`).

**Board-Regel OWL-1434 (fremde Accounts):** gewahrt. Keine `account_id` in `wrangler.jsonc` gepinnt; die Treffer auf `6d2a1d5945f8b63047a1d59a9f94de21` sind ausschließlich Kommentar/README, die das Verbot dokumentieren (`wrangler.jsonc:7-9`, `README.md:110-111`). Keine hartkodierten Secrets (nur Test-Fixtures mit Fake-Werten).

**Verifikation:** `npx tsx --test owlos/etsy-gatekeeper/*.test.ts` → **50/50 grün**, 0 fail, kein Netzzugriff (unabhängig nachgezogen). CI-Checks „Build and test"/„Lint" sind **rot auch auf `main`** (61bec25) — vorbestehend, nicht durch diesen PR eingeführt; „CLAssistant" ist der CLA-Bot (Agent-Autor), kein Code-Befund.

## 3. Bewusste v1-Abgrenzung (abgenommen)

Preis/Menge liegen bei Etsy auf `updateListingInventory` mit verschachteltem `products`-Payload, was die Primitive-/Feld-Allowlist-Invariante (das Sicherheitsrückgrat) bräche. Bewusst **nicht** in v1 (`README.md:54-62`, `write-queue.ts:17-19`). `state` (Aktivieren/Deaktivieren) + Bestellstatus decken den operativen Kern. Diese Abgrenzung ist vom Board/CEO abgenommen — **nicht** in diesem PR nachziehen; späterer, sauber modellierter Schreibpfad `listing_inventory`.

## 4. Residualrisiken / Empfehlungen (keine Merge-Blocker)

1. **CF-Access-JWT nicht in-Worker verifiziert.** Der Worker vertraut dem Header `Cf-Access-Authenticated-User-Email` ohne `Cf-Access-Jwt-Assertion` zu prüfen. Das ist korrekt, **solange** CF Access am Edge davor steht (dokumentiertes Deploy-Gate) — aber die Approval-Boundary hängt damit 100% an der Edge-Config. **Empfehlung (Härtung, künftiges Ticket):** CF-Access-JWT zusätzlich im Worker validieren (Defense-in-depth). Kein Blocker: kein Deploy, hartes Wiring-Gate, keine Credentials.
2. **Token-Rotation-Randfall.** Wenn Etsy serverseitig rotiert, die Persistenz (`KV put`) danach aber fehlschlägt, ist der neue Refresh-Token verloren → Re-Seed via `POST /api/token/seed` hinter CF Access (dokumentiert, `README.md:134-136`). Inhärentes OAuth-Rotationsrisiko, akzeptiert für v1.

## 5. Urteil

**Gate bestanden. Merge von PR #28 freigegeben.** Kein Deploy (CEO-/Board-Gate). Härtungspunkte aus §4 als spätere Tickets, nicht in diesem PR.
