# gatekeeper-vonbusch-mailbox (K1-Port · VON-1815)

Portiert `vonbusch/mailbox-gatekeeper` (VON-1797/1798) auf die OS-`GatekeeperVendor`-Gadget-
Schnittstelle. Der Baustein erscheint als Kachel im **bestehenden** CloudflareOS-Deploy — als
zusätzlicher Service + Backend-Binding, **kein neuer Deploy/Projekt** (Leitfaden:
`vonbusch/PORTING-GATEKEEPERVENDOR.md`).

## Was der Gatekeeper bindet

Genau **eine** agentic-inbox-Mailbox (URL-Muster `https://mail.vonbusch.app/inbox/<inbox-id>`). Der
Coding-Agent bekommt die `Mailbox`-RPC-Fähigkeit (`getTypeScriptTypes()`):

- Reads: `listThreads`, `getThread`, `listMessages`, `getMessage` — laufen sofort, jede als
  **auditierte Observation** (`ApprovalQueue.authorizeObservation()`).
- Writes: `sendMessage`, `reply` — werden zur **Human-in-the-Loop-Freigabe** eingereiht
  (`submitAction()`), die Wirkung tritt erst in `applyAction()` ein. Nie auto-approvable.

Es gibt **kein Mailbox-Argument** in der öffentlichen API — die Mailbox steckt im Grant (DO-props).

## Sicherheit (schließt die VON-1798-Lücke)

Der Security-Review (`docs/vonbusch/VON-1798-security-review.md`) fand: agentic-inbox hat keine
per-Mailbox-authz, CF Access war die **einzige** Boundary. Dieser Port zieht sie ein:

1. **Sichtbarkeit:** `getSupportedResources({userId})` gibt für Nicht-Berechtigte eine leere Liste
   zurück ⇒ der Gatekeeper ist für sie unsichtbar (`allowedMailboxesFor`).
2. **Sharing:** `addObserver()` prüft die ACL erneut **fail-closed** (`canObserveMailbox`) — ein
   Kollaborator ohne Freigabe für die gebundene Mailbox wird abgewiesen.
3. **Defense-in-Depth am Upstream:** jeder `tools/call` läuft durch `gateToolCall` (`pin-mailbox.ts`,
   1:1 aus VON-1798): fremde `inbox_id` → verweigert, fehlende → gepinnt injiziert.

Die ACL kommt zur Deploy-Zeit aus `MAILBOX_ACL` (JSON). Auto-provisionierte Accounts tragen keine
provider-verifizierte E-Mail; die Zuordnung realer Nutzer-Identitäten → ACL ist Teil des
CEO-Live-Bind-Schritts (siehe unten).

## Aufbau

| Datei | Rolle |
|---|---|
| `src/mailbox-gatekeeper.ts` | Worker-Entry: `GatekeeperVendor`, `MailboxAccount`, `MailboxVerifier`, `MailboxGatekeeper` (DO), `MailboxSessionRpc`. Braucht `cloudflare:workers`. |
| `src/session-core.ts` | Transport-freier Session-Kern: Read→`authorizeObservation`, Write→`enqueue`. tsx-testbar. |
| `src/mailbox-backend.ts` | `MailboxBackend`-Adapter: `McpMailboxBackend` (echter `/mcp`) + `MemoryMailboxBackend` (Tests). |
| `src/mailbox-authz.ts` | per-Mailbox-ACL (fail-closed). |
| `src/pin-mailbox.ts` | VON-1798-Pinning-Fach-Logik (1:1 übernommen). |
| `src/mcp-client.ts` | Minimaler MCP-over-HTTP-Client (aus dem Proxy übernommen). |
| `src/mailbox-api.d.ts` | Die `Mailbox`-API-Typen (= `getTypeScriptTypes()`). |

## Tests (workerd-frei)

```
npm run test:run          # node --import tsx --test test/*.test.ts  (15 Tests)
npx tsc --noEmit -p tsconfig.json
npx wrangler deploy --dry-run --outdir /tmp/gkmb
```

## Deploy-Gate (CEO, NFR-Account 6d2a1d59…)

Code + Tests laufen ohne. Der **Live-Bind** braucht vom Board/CEO:

1. `wrangler deploy` dieses Service (Name `gatekeeper-vonbusch-mailbox`) auf den NFR-Account.
2. Secrets/Vars setzen:
   - `UPSTREAM_MCP_URL` (Var, bereits in `wrangler.jsonc`) — der echte agentic-inbox `/mcp`.
   - `MAILBOX_UPSTREAM_TOKEN` (Secret): `wrangler secret put MAILBOX_UPSTREAM_TOKEN`.
   - `MAILBOX_ACL` (Var/Secret), JSON, z. B.:
     `{"mailboxes":{"inbox_ceo@vonbusch.digital":["axel@vonbusch.digital"]},"admins":["cto@vonbusch.digital"]}`
3. Am `workshop-backend` (`packages/workshop-backend/wrangler.dev.jsonc` und prod-Pendant) den
   Service-Eintrag ergänzen — erst **nach** (1), sonst schlägt der Backend-Deploy fehl:

   ```jsonc
   {
     "binding": "GATEKEEPER_VONBUSCH_MAILBOX",
     "service": "gatekeeper-vonbusch-mailbox",
     "entrypoint": "GatekeeperVendor"
   }
   ```

Danach erscheint die Kachel unter `/` (hinter CF Access) im bestehenden Deploy.
