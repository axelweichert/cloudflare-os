# vonBusch AI-Gateway-Integration (K8) — Backend-Port

**VON-1820** (Port von `vonbusch/ai-gateway-integration`, K8 / VON-1806) in die native
CloudflareOS-AI-Gateway-Fläche des `workshop-backend`. Sonderform (kein `GatekeeperVendor`-
Package): CF-OS routet LLM bereits nativ über AI Gateway, sobald `CF_AI_GATEWAY_*` gesetzt ist —
der Port ist daher **Env/Guardrail-Konfig + der Code-Mehrwert Per-User-€-Budget**, integriert
direkt am Backend statt als eigener Worker.

## Was hier liegt

| Datei | Rolle |
|-------|-------|
| `cost-budget.ts` | Speicher-agnostischer Kern: `estimateCostUsd`, `BudgetLedger` (allow/deny gegen USD-Cap, `record()` bucht Ist-Kost, `rollup()` Chargeback), `BudgetStore`-Port + `MemoryBudgetStore` (Test). |
| `kv-budget-store.ts` | **Prod-Adapter**: Workers-KV-Implementierung des `BudgetStore` (perioden-präfixierte Keys → `listPeriod` = ein `KV.list`). |
| `guardrails.ts` | Versionierte DLP/Guardrail-Policy (`VONBUSCH_GUARDRAIL_POLICY`, Single Source für die Gateway-Konfig) + `interpretGuardrailOutcome`. Finanz/PII = **FLAG** (VON-157). |
| `config.ts` | Baut & validiert den `CF_AI_GATEWAY_*`-Env-Block für `vonbusch-aigateway` (CI-Check statt Deploy-Überraschung). |
| `index.ts` | Backend-Einstieg: `getVonbuschBudgetLedger(env)` (OPT-IN-Factory) + Re-Exports. |

## Backend-Verdrahtung (bereits im Code)

`src/overseer.ts` ruft das Budget an denselben zwei Punkten wie CF-OS die native Kostenlogik:

- **Pre-Flight** — direkt nach `checkUsageAndBalance` (native Tages-CALL-Grenze): `ledger.check(ownerId, modelId, DEFAULT_PREFLIGHT_USAGE, now)`; bei `!allow` → `postAgentErrorMessage(… "usage_limit")` und Turn-Abbruch (analog zur Free-Tier-Schranke).
- **Post-Flight** — in `#getCostFromAiGateway`, wo die **autoritative** Gateway-Ist-Kost (`cf-aig-log-id` → `getAiGatewayLogCost`) gelesen wird: `ledger.record(ownerId, cost, now)`.

Attribution = `this.ownerId` (Gadget-Owner), konsistent mit dem nativen Gate.

**OFF by default.** Ohne `ENABLE_VONBUSCH_BUDGET="true"` gibt `getVonbuschBudgetLedger` `undefined`
zurück → beide Zweige sind No-ops, self-hosted/bestehende Deployments bleiben unberührt.

## Verifikation (ohne CEO / workerd-frei)

- `node --experimental-strip-types --test` gegen die drei Kern-Module: **25/25 grün**.
- `tsc -p packages/workshop-backend/tsconfig.json --noEmit`: **0 Fehler** (Backend inkl. overseer-Edits).

## Deploy-/Live-Bind-Gate (CEO)

Der Code läuft ohne die folgenden Schritte; für den Live-Betrieb sind Account-Aktionen nötig,
die nur der CEO/Operator ausführen kann (NFR-Account `6d2a1d59…`):

1. **AI-Gateway-Routing scharf** (native Fläche): in `packages/workshop-backend/wrangler.jsonc`
   (bzw. via `generate-wrangler-prod`) als `vars` setzen — `config.ts.buildGatewayEnv(...)`
   liefert exakt diesen Block:
   ```jsonc
   "vars": {
     "CF_AI_GATEWAY": "vonbusch-aigateway",
     "CF_AI_GATEWAY_ACCOUNT_ID": "<32-hex NFR-Account, Prefix 6d2a1d59…>",
     "CF_AI_GATEWAY_PROVIDERS": "anthropic,openai",
     "ENABLE_CLOUDFLARE_LIMITS": "true"
   }
   ```
   Token als **Secret**: `wrangler secret put CF_AI_GATEWAY_API_TOKEN` (Run+Read).
2. **Guardrails/DLP am Gateway `vonbusch-aigateway`** gemäß `VONBUSCH_GUARDRAIL_POLICY`
   (Dashboard/CF-API): schädliche Kategorien + Secrets = BLOCK, PII/Finanz = **FLAG** (VON-157).
3. **Rate-/Spend-Limits** am Gateway setzen (native serverseitige Kostenkontrolle).
4. **Optional: Per-User-€-Budget aktivieren** — KV-Namespace anlegen und binden, dann Flags setzen:
   ```jsonc
   "kv_namespaces": [
     { "binding": "VONBUSCH_BUDGET", "id": "<echte KV-Namespace-ID>" }
   ],
   "vars": {
     "ENABLE_VONBUSCH_BUDGET": "true",
     "VONBUSCH_BUDGET_CAP_USD": "5",          // Default-Cap pro Nutzer & Periode
     "VONBUSCH_BUDGET_PERIOD": "day",          // oder "month"
     "VONBUSCH_BUDGET_TTL_SEC": "5400000"      // optional (≈ 62 Tage), hält KV sauber
     // optional VONBUSCH_BUDGET_CAPS_JSON: {"<user-id>": 20} für Power-User
   }
   ```

Live-Bind = `wrangler deploy` des bestehenden `cloudflareos-backend` (kein neuer Worker/Projekt).
