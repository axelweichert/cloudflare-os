// vonBuschOS — AI-Gateway-Integration (K8 / VON-1820): Backend-Einstiegspunkt.
//
// Bindet den speicher-agnostischen K8-Kern (Per-User-€-Budget + Guardrail-Interpreter) an das
// workshop-backend an. Alles ist OPT-IN über `ENABLE_VONBUSCH_BUDGET` — ohne die Env-Flags gibt
// `getVonbuschBudgetLedger` `undefined` zurück und die Aufrufer in overseer.ts fallen auf das
// bestehende Verhalten zurück (keine Core-Verhaltensänderung, self-hosted unberührt).
//
// CF-OS zählt nativ nur die TAGES-CALL-ANZAHL (DAILY_LLM_CALL_LIMIT); dieses Modul ergänzt die
// nativ FEHLENDE €/USD-Kostengrenze pro Nutzer plus Chargeback-Rollup. Die native AI-Gateway-
// Routing-Fläche (CF_AI_GATEWAY_*) bleibt Konfiguration; siehe config.ts + README/PORT-NOTES.

import { BudgetLedger, type BudgetPeriod } from "./cost-budget";
import { KvBudgetStore } from "./kv-budget-store";

export {
  BudgetLedger,
  estimateCostUsd,
  periodKey,
  MemoryBudgetStore,
  DEFAULT_PRICE_TABLE,
  FALLBACK_PRICE,
  type BudgetStore,
  type BudgetDecision,
  type UserPeriodSpend,
  type TokenUsage,
  type ModelPrice,
} from "./cost-budget";
export { KvBudgetStore } from "./kv-budget-store";
export {
  VONBUSCH_GUARDRAIL_POLICY,
  interpretGuardrailOutcome,
  type GuardrailOutcome,
  type GuardrailRule,
} from "./guardrails";
export {
  buildGatewayEnv,
  validateGatewayEnv,
  VONBUSCH_GATEWAY_NAME,
  VONBUSCH_DEFAULT_PROVIDERS,
} from "./config";

function readPositiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parsePerUserCaps(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [user, cap] of Object.entries(obj)) {
      const n = typeof cap === "number" ? cap : Number.parseFloat(String(cap));
      if (Number.isFinite(n) && n >= 0) out[user] = n;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined; // Fehlkonfig darf den Turn nicht crashen; Budget bleibt dann global.
  }
}

function parsePeriod(raw: string | undefined): BudgetPeriod {
  return raw === "month" ? "month" : "day";
}

/**
 * Baut den Per-User-€-BudgetLedger aus der Env — oder `undefined`, wenn das Feature aus ist bzw.
 * unvollständig konfiguriert (fehlende KV-Bindung / fehlendes Cap). Nie werfen: eine Fehlkonfig
 * degradiert zu "kein Budget-Gate", nicht zu einem gebrochenen Turn.
 *
 * Aktiviert durch:
 *   ENABLE_VONBUSCH_BUDGET = "true"
 *   VONBUSCH_BUDGET         = KVNamespace-Bindung (Persistenz)
 *   VONBUSCH_BUDGET_CAP_USD = Default-Obergrenze pro Nutzer & Periode (USD), > 0
 * Optional:
 *   VONBUSCH_BUDGET_PERIOD    = "day" (Default) | "month"
 *   VONBUSCH_BUDGET_CAPS_JSON = {"user-id": capUsd, …} Overrides
 *   VONBUSCH_BUDGET_TTL_SEC   = KV-TTL (Sekunden)
 */
export function getVonbuschBudgetLedger(env: Cloudflare.Env): BudgetLedger | undefined {
  if (env.ENABLE_VONBUSCH_BUDGET !== "true") return undefined;
  const kv = env.VONBUSCH_BUDGET;
  const capUsd = readPositiveNumber(env.VONBUSCH_BUDGET_CAP_USD);
  if (!kv || capUsd === undefined || capUsd <= 0) return undefined;

  const ttlSeconds = readPositiveNumber(env.VONBUSCH_BUDGET_TTL_SEC);
  return new BudgetLedger({
    store: new KvBudgetStore(kv, ttlSeconds ? { ttlSeconds } : {}),
    capUsd,
    period: parsePeriod(env.VONBUSCH_BUDGET_PERIOD),
    perUserCapUsd: parsePerUserCaps(env.VONBUSCH_BUDGET_CAPS_JSON),
  });
}

/** Grobe Pre-Flight-Token-Schätzung für ein Chat-Gate ohne exakte Prompt-Zählung. */
export interface PreflightUsageHint {
  inputTokens: number;
  outputTokens: number;
}

/** Konservative Default-Schätzung (bewusst eher hoch), wenn kein präziser Prompt-Zähler vorliegt. */
export const DEFAULT_PREFLIGHT_USAGE: PreflightUsageHint = { inputTokens: 8_000, outputTokens: 2_000 };
