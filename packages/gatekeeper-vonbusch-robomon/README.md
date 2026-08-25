# gatekeeper-vonbusch-robomon (VON-1814)

Robomon als CloudflareOS-**`GatekeeperVendor`-Gadget**. Referenz-Port des read-only MCP-Bausteins
`vonbusch/robomon-gatekeeper` (K6 / VON-1803) auf die OS-Gatekeeper-Schnittstelle, damit er im
bestehenden CloudflareOS-Deploy (NFR-Account `6d2a1d59…`, Backend `workshop-backend`) als **Kachel
unter `/`** erscheint (hinter CF Access).

Kleinste Fläche = idealer Referenz-Port: ein auto-provisionierter Singleton-Account mit **vier
read-only Observations**, keine Actions, keine `ApprovalQueue`-Writes.

## Architektur

Analog `gatekeeper-context` (read-only Singleton), aber ohne Collections/Sharing/Management-UI:

| Export | Rolle |
|---|---|
| `GatekeeperVendor` | `autoProvisionsAccount: true`, mintet Account ohne OAuth (`createAccount`), `getSupportedResources` = `[]`, `getTypeScriptTypes` |
| `RobomonAccount` (`GatekeeperUser`) | Singleton-Account (`singleton.tsType = "RobomonHealth"`), liefert die DO-Class + Verifier |
| `RobomonVerifier` (`GatekeeperUserVerifier`) | Identitäts-Rückmeldung (Interface-Vollständigkeit; `addObserver` lässt jeden zu) |
| `RobomonGatekeeper` (DO, `Gatekeeper<Session>`) | `describe`/`getTypeScriptTypes`/`getAutoApprovableActions = []`/`startSession`/`addObserver` |
| `RobomonHealthSession` (`RpcTarget`) | gadget-seitige Read-Capability — jede Read läuft vor Rückgabe durch `approvalQueue.authorizeObservation()` |

Die Fach-Logik (`health.ts`, `session.ts`) ist **1:1 aus VON-1803** übernommen (runtime-agnostisch,
liest ausschließlich die von-authmon-KV `AUTHMON_KV`; schreibt nie, alarmiert nie — das macht
weiterhin von-authmon, VON-1689). Portiert wurde nur die *Hülle* (MCP-Transport → RPC-Entrypoint/DO)
und das Beobachtungs-Gate (`observations.ts` → `authorizeObservation()`).

## Vier Observations (alle read-only, gated)

- `getHealth` — vollständige Auth-/Run-Health-Observation
- `getRunActivity` — Run-Kennzahlen (heute + rollierendes Fenster + Fehlerquote)
- `getTokenStatus` — OAuth-Token-Ablauf (rein informativ)
- `getActiveAlarm` — offener von-authmon-Alarm + frisch abgeleitete Bewertung (Triage)

(plus `getHealthLine` als kompakte Ampel für Dashboards, ebenfalls gated.)

## Wiring (kein manueller Backend-Edit nötig)

Der `services`-Bind ist **package-namensgetrieben**: Dev (`scripts/run-dev-server.ts`
`findGatekeepers`), Preview/Staging (`scripts/preview/staging-config.ts`) und Release/Prod
(`scripts/release/manifest-lib.ts` `findDeployablePackages`) entdecken jedes `packages/gatekeeper-*`
mit `wrangler.jsonc` automatisch und binden es als
`GATEKEEPER_VONBUSCH_ROBOMON` → Entrypoint `GatekeeperVendor`. Das Backend
(`buildGatekeeperVendorMap`) findet es über denselben Prefix. **Der Binding-Name ist die
Verdrahtung** — nichts referenziert einen konkreten Gatekeeper.

## Bauen & Testen (workerd-lokal)

```sh
pnpm --filter @gadgets/gatekeeper-vonbusch-robomon exec tsc --noEmit   # Typecheck
pnpm --filter @gadgets/gatekeeper-vonbusch-robomon test:run            # vitest-pool-workers (workerd)
pnpm --filter @gadgets/gatekeeper-vonbusch-robomon exec wrangler deploy --dry-run --outdir /tmp/x
```

Nach Änderungen an `wrangler.jsonc`: `wrangler types` neu laufen lassen (committet als
`worker-configuration.d.ts`, Repo-Konvention).

## Deploy-Gate (CEO / Board)

Der Live-Bind braucht auf dem NFR-Account `6d2a1d59…`:

1. **read-only KV-Token** für den von-authmon `STATE`-Namespace
   (`id = 37aa431b6d464a56b8397ccf17a82913`, siehe `ops/authmon/wrangler.toml`).
2. `wrangler deploy` dieses Service (`gatekeeper-vonbusch-robomon`).
3. Backend-Binding-Rollout (automatisch über die Discovery-Skripte beim Deploy des Backends).

Code + workerd-lokale Tests laufen **ohne** diese; erst der Live-Bind ist Board-Gate.

**Acceptance:** Kachel „Robomon" unter `/` sichtbar (hinter CF Access), 4 Observations lesbar.
