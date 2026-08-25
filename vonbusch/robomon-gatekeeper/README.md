# Robomon-Gatekeeper (vonBuschOS · VON-1803 · K6)

Macht die **read-only** Auth-/Run-Health-Daten von `von-authmon` (VON-1689) als
Gadget-Baustein im Gadgets-Workshop verfügbar — für **Status-Dashboard-Gadgets**
und **Alarm-Triage-Agenten**. Rein observierend, niedriges Risiko: dieser Baustein
liest nur, er schreibt nie und alarmiert nie.

## Warum

`von-authmon` läuft out-of-band auf der Cloudflare-Kante, empfängt per Host-Cron
Heartbeats (Board-runActivity + OAuth-Ablauf) und legt seinen Zustand in einer KV
ab (`STATE`: `bootAt`, `hb`, `alarm`). Das reicht, um bei echten Ausfällen zu
mailen — aber der Zustand ist für Gadgets/Agenten nicht bequem lesbar.

Robomon macht genau diesen Zustand konsumierbar: dieselbe Klassifikationslogik wie
`von-authmon.evaluate` (identische Schwellen), aber als reine Ableitung ohne jeden
Seiteneffekt.

## Read-only (Strategy D, low-stakes)

1. **Code** — `HealthRepo` bietet nur `ladeState()`; der Worker führt nur KV-`get`
   aus. Kein `put`/`delete`, kein Cron, kein `send_email`, kein DO.
2. **Deploy** — das gebundene KV-Token wird auf Leserechte beschränkt
   (CF-Account-Aktion → CEO-Gate).

Keine Actions ⇒ keine Approval-Queue nötig (anders als die schreibenden
K-Gatekeeper CRM/Mail). Genau das passt zum rein observierenden Charakter.

## Session-Oberfläche (`session.ts`)

| Tool | Art | Zweck |
|------|-----|-------|
| `getSnapshot()` | Read | vollständige Health-Observation (Level/Kind/Detail/hb-Alter/Token/Runs) |
| `getHealthLine()` | Read | kompakte Ampel-Zeile (🟢/🔴) für Dashboards |
| `getRunActivity()` | Read | Tageszähler + rollierendes Fenster + Fehlerquote |
| `getTokenStatus()` | Read | OAuth-Ablauf (informativ; Near-Expiry ist kein Incident) |
| `getActiveAlarm()` | Read | persistierter von-authmon-Alarm + frische Bewertung (Triage) |

## MCP (`mcp-server.ts`) — für Alarm-Triage-Agenten

Streamable-HTTP-MCP mit **vier read-only Tools**: `get_health`, `get_run_activity`,
`get_token_status`, `get_active_alarm`. Jedes Tool trägt
`annotations.readOnlyHint: true` — adressiert die fehlende Annotation aus VON-1797
(Kind-Issue a602fff9), damit ein MCP-Client ohne Rückfrage lesen darf.

## Klassifikation (konsistent mit von-authmon)

```
kein hb & Boot > 45min   → ALARM NO_HEARTBEAT   (Dead-Man's-Switch)
hb-Alter > 45min         → ALARM STALE_HEARTBEAT
Fenster: >=3 Runs, 0 ok  → ALARM ZERO_SUCCESS    (Fleet-Auth-Ausfall, vgl. VON-1688)
Fenster: >=5 Runs, >=25% → ALARM HIGH_FAILRATE
sonst frisch             → OK HEALTHY
Boot innerhalb Grace     → OK BOOTING
```

Token-Ablauf ist **rein informativ** (VON-1775): Near-Expiry löst sich durch den
Refresh selbst auf; ein wirklich toter Token zeigt sich als ZERO_SUCCESS.

## KV-Schema (Quelle: `ops/authmon/src/index.js`)

```
bootAt : string  — ms-Epoch des Monitor-Boots
hb     : json    — { receivedAt, today{date,succeeded,failed,total}, window{...}, tokenExpiresAt, host }
alarm  : json    — { kind, level, since, lastNotifiedAt } | fehlt (kein offener Alarm)
```

## HTTP-Smoke (E2E unter `wrangler dev --local`)

```
GET  /health   → HealthSnapshot
GET  /runs     → RunActivityView
GET  /token    → TokenObservation | { token: null }
GET  /alarm    → { persisted, derivedLevel, derivedKind, detail }
GET  /line     → text/plain Ampel-Zeile
POST /mcp      → MCP (read-only)
```

## Test (workerd-frei, kostenfrei)

```
npx tsx --test vonbusch/robomon-gatekeeper/robomon.test.ts
```

14 Tests: alle Klassifikations-Branches, Quoten-Schwelle, Token-Info (near/expired),
Ampel-Zeile, Session-Reads, Kaltstart, MCP tools/list (4× readOnlyHint), tools/call,
Fehlerpfad. Zusätzlich Miniflare-E2E via `wrangler dev --local` (KV geseedet → /health
liefert HEALTHY, /mcp liefert 4 Tools) verifiziert.

## Status

PoC / Logik + Session + MCP + Worker + Tests grün, E2E gegen Miniflare-KV verifiziert.
Offen (Board-/CEO-Gate):

- **Prod-KV-Binding** — `read`-only-API-Token für den von-authmon-`STATE`-Namespace
  (`37aa431b…`, CF-Account 6d2a1d59… → CEO). id ist bereits in `wrangler.jsonc`
  eingetragen; ohne read-only-Token-Scope aber nicht deployen.
- **Heben in ein vollwertiges `packages/gatekeeper-*`** mit Workshop-Registrierung.
  Für einen read-only-Baustein reicht die Low-Stakes-Variante (Strategy D).
