# @gadgets/gatekeeper-vonbusch-preiserhebung

CloudflareOS-`GatekeeperVendor`-Gadget für die **Preiserhebung** — read-only Druckpreis
(printgemein) + DMS-ROI. Port des MCP-Bausteins `vonbusch/preiserhebung-gatekeeper`
(K4 / VON-1801) auf die OS-Gatekeeper-Schnittstelle (VON-1816, Umbrella VON-1813).

## Charakter

- **Read-only.** Die printgemein-Preis-D1 (`PREIS_DB`, Tabelle `preisparameter`) wird
  ausschließlich per `SELECT` gelesen. `getAutoApprovableActions()` → `[]`; es gibt keine
  Actions, keine `ApprovalQueue`-Writes, kein `applyAction`.
- **Jede Read läuft durch `authorizeObservation()`.** Vier Observations:
  `getDruckparameter`, `berechneDruckPreis`, `getDmsRoiConfig`, `berechneDmsRoi`.
- **Vertriebs-Overrides sind nicht-persistent.** „Was-wäre-wenn" justiert Parameter nur für
  den einzelnen Aufruf (`overrides`); die D1-Quelle bleibt unangetastet.
- **Auto-provisioniert** (`autoProvisionsAccount: true`), Singleton-tsType `Preiserhebung` —
  kein OAuth. Sichtbarkeit/Zugang laufen über CF Access des bestehenden Deploys.

## Aufbau

| Datei | Rolle |
|---|---|
| `src/gadget.ts` | `GatekeeperVendor` + `PreiserhebungAccount`/`Verifier`/`Gatekeeper` (DO) + `PreiserhebungReadSession` (RpcTarget) + `D1PreisRepo` |
| `src/observations.ts` | Vier gated Reads (compute → `authorizeObservation()` → return), runtime-agnostisch |
| `src/session.ts` | Runtime-agnostische Fach-Logik (1:1 aus VON-1801) über `PreisRepo` |
| `src/preis-parameter.ts` | D1-Row → Parametersatz-Mapping + Deep-Merge-Overrides |
| `src/engine/printgemein-preis.ts` | Druckpreis-Rechenkern (Transplant printgemein VON-32) |
| `src/engine/dms-roi.ts` | DMS-ROI-Rechenkern (Transplant dmsroi VON-1785/1787) |
| `src/index.ts` | Worker-Entry: Klassen-Re-Exports + minimaler `fetch()` |

## Verifikation (ohne Live-Bind)

```
pnpm install --filter @gadgets/gatekeeper-vonbusch-preiserhebung
pnpm --filter @gadgets/gatekeeper-vonbusch-preiserhebung typecheck   # tsc --noEmit
pnpm --filter @gadgets/gatekeeper-vonbusch-preiserhebung test:run    # 5 tsx-Tests
wrangler deploy --dry-run --outdir /tmp/pg                           # Build + Binding-Check
```

Der `__tests__/observations.test.ts`-Lauf belegt die Port-Schicht workerd-frei: alle vier Reads
sind gated, ein ablehnender Authorizer blockiert die Beobachtung, und der transplantierte
Rechenkern liefert durch die Observations-Schicht die bekannten Referenzwerte
(Druck-Brutto 793,78 € · DMS-ROI 60.216 €/Jahr). Die RPC/DO-Hülle prüft `tsc` + `--dry-run`.

## Deploy-Gate (CEO, VON-1816)

Live-Bind ist Board-Gate. Nötig auf NFR-Account 6d2a1d59… (bestehender CloudflareOS-Deploy):

1. **Echte D1-ID** der printgemein-Preis-D1 (`33b8cb23-…`) statt `REPLACE_WITH_PRINTGEMEIN_D1_ID`
   in `wrangler.jsonc`, gebunden mit **read-only** API-Token.
2. `wrangler deploy` dieses Workers als Service `gatekeeper-vonbusch-preiserhebung`.
3. Backend-Binding am `workshop-backend` (`wrangler.jsonc`/`wrangler.dev.jsonc`, `services`):
   ```jsonc
   { "binding": "GATEKEEPER_VONBUSCH_PREISERHEBUNG", "service": "gatekeeper-vonbusch-preiserhebung" }
   ```

Kein neuer Deploy/Projekt — nur ein weiterer Service + Binding am bestehenden Backend.
