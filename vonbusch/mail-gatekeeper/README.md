# gatekeeper-vonbusch-mail (VON-1802 / K5)

CF-Email-Outbound mit **menschlicher Freigabe-Queue**. Gadgets/Agenten *schlagen* Mails vor;
ein Mensch (hinter CF Access) gibt sie frei. Erst bei Freigabe wird real über die Cloudflare
`send_email`-Bindung von `noreply@vonbusch.app` versendet — Agenten können nie ungeprüft mailen.

Upstream-Vorlage: `packages/gatekeeper-email` (Inbound/Outbound-Framework). Diese vonbusch-Variante
ist bewusst schlank (Aufwand S), self-contained und workerd-nativ, analog zu `mailbox-gatekeeper`.

## Architektur

```
Agent ──/mcp──▶ propose_email ──▶ [pending]  ── Durable Object (Firmen-Queue) ──┐
                                                                                 │
Mensch ──GET / (CF Access) ──▶ Freigabe-UI ──POST /api/queue/:id/approve ──▶ EMAIL.send() ──▶ [sent]
                                             ──POST /api/queue/:id/reject  ──▶ [rejected]
```

- **`approval-queue.ts`** — reiner Statemachine-Kern: `pending → approved → sent|failed` bzw.
  `pending → rejected`. Erzwingt Absender-Allowlist, Header-Injection-Schutz, keine
  Doppel-Entscheidung (Race-sicher). Speicher-agnostisch (`QueueStore`).
- **`mcp-server.ts`** — Streamable-HTTP-MCP mit Tools `propose_email`, `list_my_proposals`.
- **`mailer.ts`** — RFC-822-MIME-Bau (rein/getestet) + CF-`send_email`-Adapter (injizierbar).
- **`ui.ts`** — SSR-HTML-Freigabeseite (kein Build, keine Client-Deps).
- **`worker.ts`** — DO `MailGatekeeper` (Singleton `default`) + HTTP-Routing.

## Routen

| Route | Methode | Wer | Zweck |
|---|---|---|---|
| `/mcp` | POST | Agent | MCP: `propose_email`, `list_my_proposals` |
| `/` | GET | Mensch | HTML-Freigabe-UI |
| `/api/queue[?status=]` | GET | Mensch | JSON-Liste |
| `/api/queue/:id/approve` | POST | Mensch | freigeben → versenden |
| `/api/queue/:id/reject` | POST | Mensch | ablehnen |

Die Agenten-Identität kommt aus `X-Agent-Id` (Fallback CF-Access-Email). Der freigebende Mensch
aus `Cf-Access-Authenticated-User-Email`. **CF Access vor `/` und `/api/*` ist die einzige
menschliche Boundary — bei Deploy zwingend konfigurieren.**

## Konfiguration (`wrangler.jsonc`)

- `send_email`-Bindung `EMAIL` (unrestricted → beliebige Empfänger, wie printgemein).
- `vars.ALLOWED_FROM` — Kommaliste erlaubter Absender (Default `noreply@vonbusch.app`).
- `vars.DEFAULT_FROM` — Absender, falls der Agent keinen angibt.

## Testen (workerd-frei)

```bash
npx tsx --test vonbusch/mail-gatekeeper/approval-queue.test.ts \
                vonbusch/mail-gatekeeper/mcp-server.test.ts
# 21 Tests: Statemachine, Allowlist, Header-Injection, Doppel-Send-Schutz, MCP-Flow, MIME.
```

## Lokal / E2E

```bash
npx wrangler dev -c vonbusch/mail-gatekeeper/wrangler.jsonc --port 8799 --local
# 1) propose:  POST /mcp  {method:"tools/call", params:{name:"propose_email", arguments:{to,subject,text}}}
# 2) list:     GET  /api/queue?status=pending
# 3) approve:  POST /api/queue/<id>/approve  →  Miniflare fängt send_email lokal ab, Status → "sent"
```
E2E gegen Miniflare `send_email` verifiziert (propose→pending→approve→sent, Doppel-Approve→409,
unerlaubter Absender→isError).

## Deploy (nach CF-Access-Setup)

```bash
npx wrangler deploy -c vonbusch/mail-gatekeeper/wrangler.jsonc
```
Voraussetzung: `noreply@vonbusch.app` ist als Sending-Adresse auf `vonbusch.app` onboardet
(bereits erledigt, siehe printgemein VON-1280) — kein zusätzliches Domain-Onboarding nötig.
