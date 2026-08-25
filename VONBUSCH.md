# Cloudflare OS @ von Busch Digital

Fork von [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os) →
`axelweichert/cloudflare-os`. Board-getriebene, **kostenneutrale Bau-Phase** auf `workerd`/lokal.
Kein Prod-Deployment, kein Cloudflare-Account/Billing, keine Upstream-PRs ohne separaten Board-Gate.

Governance: Analyse VON-1795 (CTO), Fork-Entscheidung durch das Board (VON-1794), Bau-Phase VON-1797.

## Was das ist

Gadgets-Workshop-Monorepo (pnpm). Erweiterungspunkte:

- **Gatekeeper** (`packages/gatekeeper-*`) — Connectoren zu externen Ressourcen. Ein Gadget bindet
  eine Ressource über eine benannte Binding, der Gatekeeper erzwingt Scope, Approval-Queue und
  Observation-Logging.
- **Blueprints** (`docs/blueprints.md`) — teilbare Gadget-Vorlagen (Code, nicht Daten/Credentials).

## Run-Spike (verifiziert, `workerd`/lokal, keine Kosten)

- `corepack pnpm install --frozen-lockfile` → exit 0 (pnpm 11.17.0, Node 24).
- `pnpm --filter @gadgets/mcp-gatekeeper test:run` → alle Tests grün (vitest/workerd).
- Lokaler Gesamtlauf: `pnpm run-local` (Workshop-Frontend + Dev-Server, serviert gebautes Frontend
  als static assets). Nicht Teil des CI-Nachweises, da langlaufender Prozess.

## P0 — K1: MCP-Andockung agentic-inbox

Ziel: unseren Agentic-Inbox-MCP-Server (`mail.vonbusch.app/mcp`, 13 Tools) als erstes
Gadget/Gatekeeper andocken. Der **generische MCP-Gatekeeper** (`packages/gatekeeper-mcp`) verbindet
jeden MCP-Server per URL — es braucht keinen agentic-inbox-spezifischen Code im Fork.

Nachweis: `packages/gatekeeper-mcp/__tests__/agentic-inbox-dock.test.ts` — treibt dieselbe
Klassifikations- und Typgenerierungs-Pipeline wie der laufende Gatekeeper, gegen die **reale**
Tool-Oberfläche (`vonbusch-app-agentic-inbox/workers/mcp/index.ts`). Verifiziert:

1. Binding-Name: `mail.vonbusch.app/mcp` → serverId `mail` → `env.MCP_MAIL`.
2. Alle 13 Tools werden zu korrekt benannten, aufrufbaren Session-Methoden (`listEmails`,
   `getEmail`, `sendReply`, …); keins fällt weg, keins wird erfunden.
3. Read/Action-Split für ein `byo`-Endpoint (vom Nutzer eingegebene URL).

### Zwei Befunde für die nächste K1-Stufe

- **Keine Tool-Annotationen upstream.** agentic-inbox setzt kein `readOnlyHint`. Unter der
  fail-closed `byo`-Klassifikation ist damit **jedes** Tool eine „action", die auf Overseer-Approval
  wartet — auch reine Lesezugriffe wie `list_emails`/`get_email`. Fix (in agentic-inbox, nicht hier):
  die 5 Read-Tools (`list_mailboxes`, `list_emails`, `get_email`, `get_thread`, `search_emails`) mit
  `readOnlyHint: true` annotieren → sie werden zu Auto-Observations. Der Test pinnt Ist-Zustand und
  Fix.
- **Auth-Grenze: CF Access ≠ MCP-OAuth.** `mail.vonbusch.app/mcp` sitzt hinter Cloudflare Access
  (JWT). Der generische Gatekeeper führt die Standard-MCP-OAuth-Kette (RFC 9728/8414/7591/7636/8707,
  Fallback `/authorize`,`/token`,`/register`). CF Access implementiert diese DCR-Kette nicht, d. h.
  ein direkter Live-Handshake gegen den geschützten Endpoint schlägt fehl. Zwei saubere Pfade
  (jeweils eigener Board-Gate für Live-/Prod-Betrieb):
  1. `gatekeeper-mcp-portal` mit vorausgestelltem CF-Service-Token vor `/mcp` betreiben, oder
  2. Standard-MCP-OAuth direkt auf `/mcp` von agentic-inbox anbieten.

Für den lokalen Spike gegen einen selbst gehosteten Inbox-`wrangler dev` genügt
`MCP_ALLOW_INSECURE=true` in der Root-`.dev.vars`.
