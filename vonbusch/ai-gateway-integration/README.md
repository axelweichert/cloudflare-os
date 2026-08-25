# AI-Gateway-Integration (vonBuschOS · VON-1806 · K8)

Richtet die **native AI-Gateway-Routing-Fähigkeit von Cloudflare OS** auf unser Gateway
`vonbusch-aigateway` (NFR-Account, Prefix `6d2a1d59…`). Damit greifen dessen **serverseitige
Kostenkontrolle, Rate-/Spend-Limits und DLP-Guardrails** für jeden LLM-Call — ohne Änderung am
CF-OS-Core. Zusätzlich liefert das Modul, was CF-OS **nativ nicht** kann: ein **€/USD-basiertes
Per-User-Budget** (optional Per-User-Billing).

## Ausgangslage (im Core verifiziert)

CF-OS routet LLM-Requests bereits vollständig über Cloudflare AI Gateway, sobald die
`CF_AI_GATEWAY_*`-Env-Variablen gesetzt sind. Belege im Repo:

| Was | Fundstelle |
|-----|-----------|
| Gateway-Env-Deklaration (`CF_AI_GATEWAY`, `…_ACCOUNT_ID`, `…_PROVIDERS`, `…_API_TOKEN`, `…_USE_BINDING`) | `packages/workshop-backend/src/env.d.ts` (~Z. 17–24) |
| Routing über `https://gateway.ai.cloudflare.com/v1/{accountId}/{gateway}` + `cf-aig-authorization` | `packages/workshop-backend/src/ai-models.ts` → `getModelViaGateway` (~Z. 442–505) |
| **Per-User-Attribution** als `cf-aig-metadata` (`{ user: initiator.id, source, gadgetId, chatId }`) — **bereits nativ** | `packages/workshop-backend/src/ai-models.ts` → `buildMetadata` (~Z. 106–115) |
| Autoritative Ist-Kosten je Call über `cf-aig-log-id` → `getAiGatewayLogCost` | `packages/workshop-backend/src/ai-gateway.ts` (~Z. 175–227) |
| Native Limit-Schranke = **Tages-CALL-ANZAHL** (`DAILY_LLM_CALL_LIMIT`), gated durch `ENABLE_CLOUDFLARE_LIMITS` | `packages/workshop-backend/src/ai-gateway-billing/…` |

**Kern-Erkenntnis:** Kostenkontrolle, Guardrails und Per-User-Attribution entstehen primär durch
**Konfiguration** (Env auf unser Gateway richten + Guardrails/DLP serverseitig am Gateway
konfigurieren), **nicht** durch Core-Code. Der einzige echte Code-Mehrwert ist das
**€-Budget** (CF-OS zählt nur Calls, nicht Kosten).

## Was dieses Modul liefert

| Datei | Zweck |
|-------|-------|
| `config.ts` | Baut & **validiert** den `CF_AI_GATEWAY_*`-Env-Block für `vonbusch-aigateway`; prüft dieselben Invarianten wie der `AiGatewayConfig`-Konstruktor (Account-ID Pflicht; Token für HTTPS/Google) → Fehlkonfig fällt in CI auf, nicht im Deploy. |
| `cost-budget.ts` | **€-Per-User-Budget**: Pre-Flight-Kostenschätzer (`estimateCostUsd`) + `BudgetLedger` (allow/deny gegen USD-Cap, Ist-Kosten buchen aus dem Gateway-Log, `rollup()` für Chargeback). Speicher-agnostischer Kern + `BudgetStore`-Port (KV/DO in Prod). |
| `guardrails.ts` | Versionierte **DLP/Guardrail-Policy** (Single Source für die CEO-Gateway-Konfiguration) + `interpretGuardrailOutcome` (geblockte/geflaggte Gateway-Antwort → saubere Meldung). Finanz/PII auf **FLAG** (Lehre aus VON-157). |
| `ai-gateway.test.ts` | 25 Tests, `npx tsx --test`, workerd-frei. |

## Verwendung (Env-Wiring)

```ts
import { buildGatewayEnv, validateGatewayEnv } from "./config.ts";

// Env-Block für die workshop-backend-wrangler.jsonc erzeugen:
const env = buildGatewayEnv({
  accountId: "<32-hex NFR-Account, Prefix 6d2a1d59…>",
  providers: ["anthropic", "openai"],   // verifiziert 200 auf vonbusch-aigateway (VON-227)
  // apiToken via `wrangler secret put CF_AI_GATEWAY_API_TOKEN` (nicht ins Repo!)
});

const check = validateGatewayEnv({ ...env, CF_AI_GATEWAY_API_TOKEN: "present" });
if (!check.ok) throw new Error(JSON.stringify(check.issues));
```

Konkret in `packages/workshop-backend/wrangler.jsonc` (bzw. via `generate-wrangler-prod`) als
`vars` setzen: `CF_AI_GATEWAY=vonbusch-aigateway`, `CF_AI_GATEWAY_ACCOUNT_ID=<…>`,
`CF_AI_GATEWAY_PROVIDERS=anthropic,openai`, `ENABLE_CLOUDFLARE_LIMITS=true`; das Token als
**Secret**.

### Optional: €-Per-User-Budget verdrahten

Der `BudgetLedger` ergänzt die native Call-Zählung. Idealer Aufruf-Punkt in
`packages/workshop-backend/src/ai-models.ts`:

- **Pre-Flight** (vor `makeHandle`, mit einer Token-Schätzung): `ledger.check(userId, modelId, usage, now)`
  → bei `!allow` den Call ablehnen (analog zur bestehenden Free-Tier-Schranke).
- **Post-Flight** (im `onResponse`-Pfad, wo `cf-aig-log-id` schon gelesen wird und
  `getAiGatewayLogCost` die autoritative Zahl liefert): `ledger.record(userId, actualUsd, now)`.

`userId` = `initiator.id` — dieselbe Identität, die bereits in `cf-aig-metadata` steht. Der
`BudgetStore` wird in Prod von KV oder einem Durable Object bedient (In-Memory nur im Test).

## Guardrails (serverseitig am Gateway)

Guardrails/DLP laufen **auf dem Gateway**, nicht im Code. `VONBUSCH_GUARDRAIL_POLICY`
beschreibt die zu setzende Konfiguration: schädliche Kategorien **BLOCK**, Secrets **BLOCK**,
PII/Finanz **FLAG** (kein Hard-Block — VON-157 zeigte, dass ein Finanz-BLOCK die CRM-KI mit HTTP
424 brach). `interpretGuardrailOutcome` übersetzt die Gateway-Antwort für Agenten.

## Deploy / Wiring-Gate (CEO)

Dieses Modul ändert den Core **nicht** und wird **nicht** nach `main` gemergt. Für den
Live-Betrieb sind Account-/Gateway-Aktionen nötig, die nur der CEO/Operator ausführen kann:

1. **Volle NFR-Account-ID** (32-hex, Prefix `6d2a1d59…`) für `CF_AI_GATEWAY_ACCOUNT_ID`.
2. `wrangler secret put CF_AI_GATEWAY_API_TOKEN` — **Run+Read**-Token des Gateways.
3. **Guardrails/DLP am Gateway `vonbusch-aigateway` konfigurieren** gemäß
   `VONBUSCH_GUARDRAIL_POLICY` (Dashboard/CF-API). Finanz/PII = FLAG.
4. **Rate-/Spend-Limits** am Gateway setzen (native Kostenkontrolle).
5. Optional Per-User-€-Budget: KV/DO-Binding für den `BudgetStore` + `BudgetLedger` an den zwei
   oben genannten Punkten in `ai-models.ts` einhängen.

## Tests

```bash
npx tsx --test vonbusch/ai-gateway-integration/ai-gateway.test.ts   # 25 Tests, workerd-frei
```

## Konventionen (vonbusch/ K-Gatekeeper)

Reiner, speicher-agnostischer Kern (workerd-frei, `npx tsx --test`) + dünner Store-Port;
Wiring als getesteter Code statt Prosa; Live-Deploy = CEO-Gate. Konsistent mit K2 (CRM), K3
(JustIn-ERP) und K5 (Mail).
