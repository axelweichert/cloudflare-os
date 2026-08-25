# Mailbox-Pinning-Proxy (vonBuschOS · VON-1798)

Schließt die per-mailbox-authz-Lücke, die das Stufe-4-Security-Review
(`docs/vonbusch/VON-1798-security-review.md`) beim Andocken von agentic-inbox `/mcp` an
`gatekeeper-mcp` gefunden hat.

## Warum

`gatekeeper-mcp` verengt Grants nur über **Tool-Namen**, nie über **Tool-Argumente**
(`mcp-shared/src/scope.ts`). agentic-inbox trägt die Mailbox aber als **Argument** (`inbox_id`) und
bietet mailbox-übergreifende Tools. Named-Tool-Scoping verengt daher auf **keine** Mailbox — es
exponiert alle.

## Was diese Schicht tut (fail-closed)

Ein dünner MCP-Proxy zwischen `gatekeeper-mcp` und agentic-inbox `/mcp`, gepinnt auf **eine** Mailbox:

- `buildPinPlan(upstreamTools, cfg)` → beworbene (verengte) `tools/list` + Zugriffsplan.
  - nicht verengbare / mailbox-übergreifende Tools werden entfernt,
  - das Mailbox-Argument wird aus dem beworbenen Schema geschnitten.
- `gateToolCall(name, args, plan, cfg)` erzwingt pro `tools/call`:
  - fremde Mailbox im Argument → **Ablehnung** (auditiert),
  - fehlendes Argument → Mailbox wird **injiziert**,
  - nicht freigegebenes Tool → **Ablehnung**.

HITL-Approval + Observation-Audit liefert der `gatekeeper-mcp` darüber bereits; diese Schicht ergänzt
nur die fehlende per-mailbox-authz.

## Test (workerd-frei, kostenfrei)

```
npx tsx --test vonbusch/mailbox-gatekeeper/pin-mailbox.test.ts
```

## Status

PoC / Durchsetzungslogik + Tests grün. Offen: Heben in einen `WorkerEntrypoint` mit `/mcp`-Transport
+ Mailbox-DO und End-to-End-Nachweis unter `wrangler dev` (siehe Review, Abschnitt 7).
