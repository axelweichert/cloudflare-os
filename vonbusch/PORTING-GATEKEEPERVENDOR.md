# Portierung: vonbusch-Gatekeeper → CloudflareOS `GatekeeperVendor`-Gadgets

**Kontext (VON-1813, CEO-Entscheidung A_port, Interaction 25635955):** Unsere sieben
Bausteine unter `vonbusch/*` sind **eigenständige MCP-over-HTTP-Worker**. Damit sie im
laufenden CloudflareOS-Deploy als echte Kacheln unter `/` erscheinen (hinter CF Access),
müssen sie auf die **OS-`GatekeeperVendor`-Gadget-Schnittstelle** portiert werden. Dies ist
ein anderes Interface, kein Deploy-Detail — daher pro Gadget ein Kind-Issue.

Dieses Dokument ist der verbindliche Leitfaden für alle sieben Port-Kind-Issues.

---

## 1. Ziel-Architektur (aus dem Upstream verifiziert)

Jeder OS-Gatekeeper ist ein **eigenes Worker-Package** `packages/gatekeeper-<name>/`
(siehe die 16 Upstream-Packages `packages/gatekeeper-*`). Ein Package exportiert:

| Export | Interface | Rolle |
|---|---|---|
| `class GatekeeperVendor extends WorkerEntrypoint` | `@gadgets/workshop-shared/gatekeeper` `GatekeeperVendor` (Zeile 445) | Vendor-Beschreibung, Account-Provisionierung, unterstützte Ressourcen, TS-Typen |
| `class <Name>Gatekeeper extends DurableObject` | `Gatekeeper<Session>` (Zeile 698) | pro Ressource: `describe`, `startSession(approvalQueue)`, `addObserver`, `getAutoApprovableActions` |
| optionale Account-/Control-DOs | `GatekeeperUser` (567), `GatekeeperUserVerifier` (689) | Account-Identität / Sign-in-Verifikation |

Registrierung im **`workshop-backend`** über einen `services`-Eintrag
(`wrangler.dev.jsonc` / prod-wrangler):

```jsonc
{ "binding": "GATEKEEPER_VONBUSCH_<NAME>", "service": "gatekeeper-vonbusch-<name>" }
```

Deploy = eigener Worker **auf demselben NFR-Account 6d2a1d59…** wie der bestehende Deploy
(`cloudflareos`, `cloudflareos-backend`, `cloudflareos-gk-context`,
`cloudflareos-gk-scheduler`). **Kein neues Projekt, kein zweiter Deploy** — nur ein weiterer
Service + Binding am bestehenden Backend.

## 2. Pflicht-Methoden `GatekeeperVendor`

- `describe(): VendorDescription` — `displayName`, `url`, `logo`, `tagline`. Read-only-
  Bausteine ohne OAuth setzen `autoProvisionsAccount: true`.
- `getSupportedResources({userId?}): SupportedResource[]` — `urlPattern`, `title`, `description`.
  **Leere Liste ⇒ Gadget bleibt für den User unsichtbar** (Gate für interne Sichtbarkeit).
- `getTypeScriptTypes(): string` — `.d.ts`-Quelltext aller von `ResourceDescription`
  referenzierten Typen. Der Coding-Agent bekommt daraus die API-Oberfläche.
- `connectAccount(callback, options?)` — OAuth-Flow (nur Vendoren mit echtem Remote-Login,
  d.h. bei uns keiner; wir nutzen `autoProvisionsAccount`/interne Creds).
- `createAccount?()` — nur wenn `autoProvisionsAccount: true`: mintet Account ohne OAuth.

## 3. Pflicht-Methoden `Gatekeeper<Session>` (DO)

- `describe(): ResourceDescription` — Anzeige vor Grant.
- `getTypeScriptTypes()` — Teilmenge der Vendor-Typen für genau diese Ressource.
- `getAutoApprovableActions(): ActionKind[]` — read-only ⇒ `[]`.
- `startSession(approvalQueue): Session` — liefert die RPC-Capability ans Gadget.
  **Jede Read-Operation muss vor Rückgabe `approvalQueue.authorizeObservation()` durchlaufen;
  jede schreibende Aktion `approvalQueue.submitAction()` und darf erst nach Approval wirken.**
- `addObserver(id)` — prüft, ob der neue User alles bisher Beobachtete sehen darf; wirft sonst.

## 4. Konzept-Mapping: unser MCP-Baustein → OS-Gadget

| Standalone-MCP (heute) | GatekeeperVendor-Gadget (Ziel) |
|---|---|
| MCP-Tool mit `readOnlyHint: true` | Methode auf `Session`, geführt durch `authorizeObservation()` |
| schreibendes MCP-Tool + DO-Approval-Queue | `Session`-Methode → `approvalQueue.submitAction()` → DO `applyAction()` |
| `wrangler -c … dev` Einzelworker + `/mcp`-HTTP | `packages/gatekeeper-*` Worker via RPC-Service-Binding |
| Tool-Liste in `mcp-server.ts` | `getSupportedResources()` + `getTypeScriptTypes()` |
| Datenzugriff in `session.ts` (KV/D1/HTTP) | identisch wiederverwendbar — Kern-Logik wandert 1:1 in die DO-`Session` |

**Gute Nachricht:** Die eigentliche Fach-Logik (`session.ts`, Repos, D1/KV-Zugriffe,
Approval-Queue-DO) ist bereits sauber vom Transport getrennt und wird **weitgehend 1:1
übernommen**. Portiert wird die *Hülle* (MCP-Transport → RPC-Entrypoint/DO) und das
Approval-Modell (unsere DO-Queue → OS-`ApprovalQueue.submitAction`/`applyAction`).

## 5. Referenz & Reihenfolge

- **K6 robomon** (read-only, KV, keine Actions) = **Referenz-Port zuerst**. Kleinste Fläche:
  vier Observations, keine `ApprovalQueue`-Writes, `autoProvisionsAccount: true`.
- Danach die read-only-lastigen (K1 mailbox, K4 preiserhebung), dann die
  approval-schreibenden (K2 crm, K5 mail), zuletzt die Sonderformen (K7 blueprints, K8
  ai-gateway — teils Konfig/Loopback statt klassischer Ressource).
- Upstream-Templates: `packages/integration-tests/fixtures/gatekeeper-test/` (minimal,
  auto-provision), `packages/gatekeeper-context/` (read-heavy Singleton),
  `packages/gatekeeper-linear/` (Actions + Approval).

## 6. Deploy-Gate pro Gadget (CEO)

Der Live-Bind-Schritt jedes Ports braucht vom Board/CEO: die **echte D1-/KV-ID** der
jeweiligen Datenquelle auf dem NFR-Account plus **read-only bzw. approval-Token/Secrets**.
Code + workerd-lokale Tests laufen ohne diese; erst `wrangler deploy` + Backend-Binding sind
Board-Gate. Jedes Kind-Issue trägt diesen Blocker explizit.
