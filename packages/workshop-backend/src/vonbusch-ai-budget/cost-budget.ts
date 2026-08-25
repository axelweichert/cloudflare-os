// vonBuschOS — AI-Gateway-Integration: Per-User-Kostenbudget (VON-1806 / K8)
//
// CF-OS begrenzt die Free-Tier nativ per TAGES-CALL-ANZAHL (DAILY_LLM_CALL_LIMIT). Was nativ
// FEHLT ist eine €/USD-BASIERTE Kostengrenze pro Nutzer — ein 100-Token-Call und ein
// 200k-Token-Call zählen dort gleich. Dieses Modul liefert genau das: einen
// Pre-Flight-Kostenschätzer + einen Per-User-Ledger, der gegen ein USD-Cap entscheidet
// (allow/deny) und Ist-Kosten für Chargeback ("optional Per-User-Billing") aufsummiert.
//
// Autoritative Kosten liefert das AI Gateway selbst über die Log-ID (cf-aig-log-id →
// getAiGatewayLogCost in packages/workshop-backend/src/ai-gateway.ts). Die Preistabelle hier
// dient NUR der Pre-Flight-Schätzung; nach dem Call wird mit der autoritativen Gateway-Zahl
// via `record()` reconciled. Dieselbe `{user}`-Attribution, die CF-OS bereits als
// cf-aig-metadata mitschickt (buildMetadata), ist der Schlüssel dieses Ledgers.
//
// Reiner Kern (kein cloudflare:workers-Import) → in Node testbar. Persistenz über den
// `BudgetStore`-Port (KV/DO in Prod, In-Memory im Test) — konsistent mit der
// vonbusch/ K-Gatekeeper-Konvention (speicher-agnostischer Kern + dünner Shim).

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD pro 1 Mio Tokens. NUR Pre-Flight-Schätzung — autoritativ ist die Gateway-Log-Kost. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// Grobe Richtpreise (USD / 1M Tokens), Stand 2026-08. Bewusst konservativ (eher zu hoch) für
// die Vorab-Entscheidung; die exakte Verrechnung kommt aus dem Gateway-Log. Erweiterbar/
// überschreibbar via BudgetLedger-Option `prices`.
export const DEFAULT_PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-5": { input: 2.5, output: 10 },
  "gpt-5-mini": { input: 0.5, output: 2 },
};

/** Fallback-Preis für unbekannte Modelle: konservativ hoch, damit Budgets nicht unterschätzt werden. */
export const FALLBACK_PRICE: ModelPrice = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

const PER_TOKEN = 1_000_000;

/** Pre-Flight-Kostenschätzung in USD aus Token-Verbrauch + Modellpreis. */
export function estimateCostUsd(
  modelId: string,
  usage: TokenUsage,
  prices: Record<string, ModelPrice> = DEFAULT_PRICE_TABLE,
): number {
  const p = prices[modelId] ?? FALLBACK_PRICE;
  const cost =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) +
      (usage.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input)) /
    PER_TOKEN;
  return Math.max(0, cost);
}

// ---------------------------------------------------------------------------
// Abrechnungsperiode: UTC-Tag oder -Monat. Zeit wird injiziert (nowMs), damit der Kern
// deterministisch testbar bleibt (kein Date.now() im Kern).
export type BudgetPeriod = "day" | "month";

/** Kanonischer Perioden-Schlüssel (UTC): "2026-08-25" (day) bzw. "2026-08" (month). */
export function periodKey(period: BudgetPeriod, nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (period === "month") return `${y}-${m}`;
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface UserPeriodSpend {
  userId: string;
  period: string;
  /** Aufsummierte AUTORITATIVE Ist-Kosten (USD) aus den Gateway-Logs. */
  spentUsd: number;
  /** Anzahl abgerechneter Calls in der Periode. */
  calls: number;
}

/** Persistenz-Port. Schlüssel = `${userId}::${period}`. Prod: KV/DO; Test: Map. */
export interface BudgetStore {
  get(userId: string, period: string): Promise<UserPeriodSpend | undefined>;
  put(row: UserPeriodSpend): Promise<void>;
  /** Alle Zeilen einer Periode — für Chargeback-Rollup. */
  listPeriod(period: string): Promise<UserPeriodSpend[]>;
}

/** In-Memory-Store (Tests / lokal). */
export class MemoryBudgetStore implements BudgetStore {
  private rows = new Map<string, UserPeriodSpend>();
  private key(userId: string, period: string) { return `${userId}::${period}`; }
  async get(userId: string, period: string) { return this.rows.get(this.key(userId, period)); }
  async put(row: UserPeriodSpend) { this.rows.set(this.key(row.userId, row.period), { ...row }); }
  async listPeriod(period: string) {
    return [...this.rows.values()].filter((r) => r.period === period).map((r) => ({ ...r }));
  }
}

export interface BudgetDecision {
  allow: boolean;
  /** Bereits verbraucht (USD) in der aktuellen Periode. */
  spentUsd: number;
  /** Geschätzte Kosten dieses Calls (USD). */
  estimateUsd: number;
  /** Obergrenze (USD) für den Nutzer in der Periode. */
  capUsd: number;
  /** Verbleibendes Budget NACH diesem Call (USD), ≥ 0. */
  remainingUsd: number;
  reason?: string;
}

export interface BudgetLedgerOptions {
  store: BudgetStore;
  /** Default-Obergrenze (USD) pro Nutzer & Periode. */
  capUsd: number;
  period?: BudgetPeriod;
  prices?: Record<string, ModelPrice>;
  /** Nutzer-spezifische Overrides der Obergrenze (z.B. Power-User). */
  perUserCapUsd?: Record<string, number>;
}

/**
 * Per-User-€-Budget als Ergänzung zur nativen CF-OS-Call-Anzahl-Grenze.
 *
 *  Pre-Flight:  `check(userId, modelId, usage, nowMs)` → allow/deny gegen das USD-Cap
 *               (schätzt die Kosten aus der Preistabelle; blockt, wenn spent+estimate > cap).
 *  Post-Flight: `record(userId, actualUsd, nowMs)` → bucht die AUTORITATIVE Gateway-Kost.
 *  Chargeback:  `rollup(nowMs)` → Ist-Kosten je Nutzer der laufenden Periode.
 */
export class BudgetLedger {
  private store: BudgetStore;
  private capUsd: number;
  private period: BudgetPeriod;
  private prices: Record<string, ModelPrice>;
  private perUserCap: Record<string, number>;

  constructor(opts: BudgetLedgerOptions) {
    if (opts.capUsd < 0) throw new Error("capUsd darf nicht negativ sein.");
    this.store = opts.store;
    this.capUsd = opts.capUsd;
    this.period = opts.period ?? "day";
    this.prices = opts.prices ?? DEFAULT_PRICE_TABLE;
    this.perUserCap = opts.perUserCapUsd ?? {};
  }

  private capFor(userId: string): number {
    const c = this.perUserCap[userId];
    return typeof c === "number" ? c : this.capUsd;
  }

  /** Pre-Flight-Entscheidung. Bucht NICHTS — Schätzung bucht erst `record()` autoritativ. */
  async check(userId: string, modelId: string, usage: TokenUsage, nowMs: number): Promise<BudgetDecision> {
    const period = periodKey(this.period, nowMs);
    const row = await this.store.get(userId, period);
    const spentUsd = row?.spentUsd ?? 0;
    const capUsd = this.capFor(userId);
    const estimateUsd = estimateCostUsd(modelId, usage, this.prices);
    const projected = spentUsd + estimateUsd;
    const allow = projected <= capUsd;
    return {
      allow,
      spentUsd,
      estimateUsd,
      capUsd,
      remainingUsd: Math.max(0, capUsd - projected),
      reason: allow ? undefined : `Budget überschritten: ${projected.toFixed(4)} USD > Cap ${capUsd.toFixed(2)} USD.`,
    };
  }

  /** Post-Flight: autoritative Gateway-Ist-Kost (USD) auf den Nutzer buchen. */
  async record(userId: string, actualUsd: number, nowMs: number): Promise<UserPeriodSpend> {
    if (actualUsd < 0) throw new Error("actualUsd darf nicht negativ sein.");
    const period = periodKey(this.period, nowMs);
    const row = (await this.store.get(userId, period)) ?? { userId, period, spentUsd: 0, calls: 0 };
    const updated: UserPeriodSpend = {
      userId,
      period,
      spentUsd: row.spentUsd + actualUsd,
      calls: row.calls + 1,
    };
    await this.store.put(updated);
    return updated;
  }

  async spentFor(userId: string, nowMs: number): Promise<number> {
    const row = await this.store.get(userId, periodKey(this.period, nowMs));
    return row?.spentUsd ?? 0;
  }

  /** Chargeback-Rollup der laufenden Periode: je Nutzer Ist-Kosten + Call-Anzahl. */
  async rollup(nowMs: number): Promise<UserPeriodSpend[]> {
    return this.store.listPeriod(periodKey(this.period, nowMs));
  }
}
