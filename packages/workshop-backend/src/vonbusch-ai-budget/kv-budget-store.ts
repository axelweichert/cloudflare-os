// vonBuschOS — AI-Gateway-Integration: KV-Adapter für den Per-User-€-Budget-Store (K8 / VON-1820).
//
// Der speicher-agnostische Kern (cost-budget.ts) definiert den `BudgetStore`-Port; MemoryBudgetStore
// bedient ihn im Test. Für den Prod-Betrieb im workshop-backend liegt hier die Workers-KV-Bindung.
// Schlüsselschema ist PERIODEN-PRÄFIXIERT (`budget:<period>:<userId>`), damit `listPeriod` als ein
// einziges `KV.list({ prefix })` läuft (Chargeback-Rollup) — anders als der userId-präfixierte
// Memory-Key, weil KV nur Präfix-Scans kennt.
//
// Bewusst dünn: keine Fach-Logik, nur Serialisierung. Alle Budget-Entscheidungen trifft der
// BudgetLedger im Kern.

import type { BudgetStore, UserPeriodSpend } from "./cost-budget";

const PREFIX = "budget:";

function rowKey(userId: string, period: string): string {
  // period zuerst → präfix-scanbar je Abrechnungsperiode. userId wird enkodiert, damit ein ":" im
  // (theoretisch beliebigen) userId das Schema nicht zerlegt.
  return `${PREFIX}${period}:${encodeURIComponent(userId)}`;
}

function periodPrefix(period: string): string {
  return `${PREFIX}${period}:`;
}

export interface KvBudgetStoreOptions {
  /** Optionaler KV-TTL (Sekunden). Abrechnungsperioden altern von selbst; ein TTL hält KV sauber. */
  ttlSeconds?: number;
}

/** Workers-KV-Implementierung des `BudgetStore`-Ports. */
export class KvBudgetStore implements BudgetStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly opts: KvBudgetStoreOptions = {},
  ) {}

  async get(userId: string, period: string): Promise<UserPeriodSpend | undefined> {
    const raw = await this.kv.get(rowKey(userId, period), "json");
    return (raw as UserPeriodSpend | null) ?? undefined;
  }

  async put(row: UserPeriodSpend): Promise<void> {
    const opts = this.opts.ttlSeconds ? { expirationTtl: this.opts.ttlSeconds } : undefined;
    await this.kv.put(rowKey(row.userId, row.period), JSON.stringify(row), opts);
  }

  async listPeriod(period: string): Promise<UserPeriodSpend[]> {
    const out: UserPeriodSpend[] = [];
    let cursor: string | undefined;
    // KV-List ist paginiert; über alle Seiten iterieren, damit der Rollup vollständig ist.
    do {
      const page = await this.kv.list({ prefix: periodPrefix(period), cursor });
      for (const k of page.keys) {
        const row = (await this.kv.get(k.name, "json")) as UserPeriodSpend | null;
        if (row) out.push(row);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }
}
