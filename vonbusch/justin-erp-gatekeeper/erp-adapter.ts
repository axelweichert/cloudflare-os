// vonBuschOS — JustIn-ERP-Gatekeeper: ERP-Datenzugriff (VON-1804 / K3)
//
// Kapselt Lese- und Schreibzugriff auf das JustIn-ERP als capability-basierte Ressourcen.
// Reads (Rechnungen/Aufträge/Bestände/Auftragsstatus) sind read-only und direkt erlaubt;
// die EINZIGE mutierende Aktion (Angebot erstellen) läuft ausschließlich über bereits
// freigegebene Aktionen aus der Approval-Queue (quote-queue.ts / worker.ts).
//
// Zwei Implementierungen:
//   - `MemoryErpAdapter` — In-Memory, deterministisch, für Unit-Tests & lokale Nutzung
//                          (workerd-frei, `npx tsx --test`).
//   - `HttpErpAdapter`   — spricht die reale JustIn-REST-API über `fetch` an.
//
// ⚠️ API-OBERFLÄCHE UNBESTÄTIGT (Issue VON-1804: "ERP-API-Oberfläche/Auth vorab klären").
//    Die in `HttpErpAdapter` kodierten Pfade/Formate sind eine EXPLIZITE ANNAHME (REST +
//    Bearer-Token). Sie werden zentral über `ErpHttpProfile` konfiguriert, damit die
//    Anpassung an die echte JustIn-Schnittstelle NICHT den Gatekeeper-Kern berührt.
//    Vor Prod-Wiring muss der CEO Endpoint/Auth/Payload-Shape bestätigen (siehe README).

export const MAX_READ_LIMIT = 200;
export const DEFAULT_READ_LIMIT = 50;

// ---------------------------------------------------------------------------
// Ressourcen-Formen (capability-basiert: der Gatekeeper reicht nur diese Felder durch).

export interface Invoice {
  id: string;
  number?: string;
  customerId?: string;
  customerName?: string;
  status?: string; // z.B. offen | bezahlt | storniert
  total?: number;
  currency?: string;
  date?: string;
}

export interface Order {
  id: string;
  number?: string;
  customerId?: string;
  customerName?: string;
  status?: string; // z.B. angelegt | in_bearbeitung | versandt | abgeschlossen
  total?: number;
  currency?: string;
  date?: string;
}

/** Ergebnis von "Auftragsstatus prüfen" — reine Leseauskunft, kein Seiteneffekt. */
export interface OrderStatus {
  orderId: string;
  number?: string;
  status: string;
  updatedAt?: string;
  note?: string;
}

export interface InventoryItem {
  sku: string;
  name?: string;
  onHand: number; // verfügbarer Bestand
  reserved?: number;
  unit?: string;
  warehouse?: string;
}

export interface ReadOptions {
  /** Freitext (Nummer/Kunde/SKU) — der Adapter filtert bzw. reicht ihn an die ERP-API. */
  search?: string;
  /** Filter auf einen Kunden. */
  customerId?: string;
  /** Statusfilter (roh an die ERP-Semantik durchgereicht). */
  status?: string;
  limit?: number;
  offset?: number;
}

/** Eine Angebotsposition. */
export interface QuoteLine {
  sku: string;
  qty: number;
  /** Optionaler Stückpreis (netto). Fehlt er, kalkuliert das ERP aus Stammdaten. */
  unitPrice?: number;
}

/** Nutzlast für "Angebot erstellen" — die einzige mutierende Aktion. */
export interface CreateQuoteInput {
  customerId: string;
  lines: QuoteLine[];
  note?: string;
  /** Gültig-bis (ISO-Datum). */
  validUntil?: string;
}

export interface ErpAdapter {
  listInvoices(opts?: ReadOptions): Promise<Invoice[]>;
  listOrders(opts?: ReadOptions): Promise<Order[]>;
  getOrderStatus(orderId: string): Promise<OrderStatus | undefined>;
  listInventory(opts?: ReadOptions): Promise<InventoryItem[]>;
  /** Wird NUR nach menschlicher Freigabe aufgerufen (worker.ts). */
  createQuote(input: CreateQuoteInput): Promise<{ quoteId: string; number?: string }>;
}

export function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_READ_LIMIT;
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}
export function clampOffset(offset?: number): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

// ---------------------------------------------------------------------------
// In-Memory-Adapter — deterministisch, für Tests & lokale Nutzung.
export class MemoryErpAdapter implements ErpAdapter {
  private invoices = new Map<string, Invoice>();
  private orders = new Map<string, Order>();
  private inventory = new Map<string, InventoryItem>();
  private quotes: Array<{ quoteId: string; number: string; input: CreateQuoteInput }> = [];
  private quoteSeq = 0;

  seedInvoices(rows: Invoice[]) { for (const r of rows) this.invoices.set(r.id, r); return this; }
  seedOrders(rows: Order[]) { for (const r of rows) this.orders.set(r.id, r); return this; }
  seedInventory(rows: InventoryItem[]) { for (const r of rows) this.inventory.set(r.sku, r); return this; }
  /** Testeinblick: welche Angebote wurden real erzeugt (nach Freigabe)? */
  createdQuotes() { return this.quotes; }

  async listInvoices(opts: ReadOptions = {}): Promise<Invoice[]> {
    return paginate(filterRows([...this.invoices.values()], opts, ["number", "customerName"]), opts);
  }
  async listOrders(opts: ReadOptions = {}): Promise<Order[]> {
    return paginate(filterRows([...this.orders.values()], opts, ["number", "customerName"]), opts);
  }
  async getOrderStatus(orderId: string): Promise<OrderStatus | undefined> {
    const o = this.orders.get(orderId);
    if (!o) return undefined;
    return { orderId: o.id, number: o.number, status: o.status ?? "unbekannt", updatedAt: o.date };
  }
  async listInventory(opts: ReadOptions = {}): Promise<InventoryItem[]> {
    let rows = [...this.inventory.values()];
    if (opts.search) {
      const n = opts.search.toLowerCase();
      rows = rows.filter((r) => `${r.sku} ${r.name ?? ""}`.toLowerCase().includes(n));
    }
    return paginate(rows, opts);
  }
  async createQuote(input: CreateQuoteInput): Promise<{ quoteId: string; number: string }> {
    this.quoteSeq += 1;
    const quoteId = `q_${this.quoteSeq}`;
    const number = `AN-${String(this.quoteSeq).padStart(5, "0")}`;
    this.quotes.push({ quoteId, number, input });
    return { quoteId, number };
  }
}

function filterRows<T extends Record<string, unknown>>(
  rows: T[],
  opts: ReadOptions,
  searchCols: string[],
): T[] {
  let out = rows;
  if (opts.customerId) out = out.filter((r) => String(r.customerId ?? "") === opts.customerId);
  if (opts.status) out = out.filter((r) => String(r.status ?? "") === opts.status);
  if (opts.search) {
    const n = opts.search.toLowerCase();
    out = out.filter((r) => searchCols.some((c) => String(r[c] ?? "").toLowerCase().includes(n)));
  }
  return out;
}
function paginate<T>(rows: T[], opts: ReadOptions): T[] {
  const offset = clampOffset(opts.offset);
  return rows.slice(offset, offset + clampLimit(opts.limit));
}

// ---------------------------------------------------------------------------
// HTTP-Adapter — spricht die reale JustIn-REST-API an.
//
// ⚠️ ANNAHME (bis CEO-Bestätigung, siehe README "Wiring-Gate"):
//   - REST/JSON über einen Basis-Endpoint (`ERP_ENDPOINT`).
//   - Bearer-Token-Auth (`ERP_TOKEN`) via `Authorization: Bearer …`.
//   - Pfade & Feld-Mapping laut `DEFAULT_JUSTIN_PROFILE` — jederzeit ohne Kern-Änderung
//     über ein anderes `ErpHttpProfile` austauschbar (z.B. SOAP-Bridge, andere Feldnamen).

export interface ErpHttpProfile {
  paths: {
    invoices: string;
    orders: string;
    /** `{id}` wird durch die Auftrags-ID ersetzt. */
    orderStatus: string;
    inventory: string;
    quotes: string;
  };
  /** Extrahiert das Array aus der Listen-Antwort (manche APIs wrappen in `{data:[…]}`). */
  extractList?: (body: unknown) => unknown[];
  /** Rechnet ERP-Rohobjekte in unsere Ressourcen-Form um. Default: 1:1 (best effort). */
  mapInvoice?: (raw: any) => Invoice;
  mapOrder?: (raw: any) => Order;
  mapOrderStatus?: (raw: any, orderId: string) => OrderStatus;
  mapInventory?: (raw: any) => InventoryItem;
}

export const DEFAULT_JUSTIN_PROFILE: ErpHttpProfile = {
  paths: {
    invoices: "/invoices",
    orders: "/orders",
    orderStatus: "/orders/{id}/status",
    inventory: "/inventory",
    quotes: "/quotes",
  },
  extractList: (body) => {
    if (Array.isArray(body)) return body;
    if (body && typeof body === "object" && Array.isArray((body as any).data)) return (body as any).data;
    if (body && typeof body === "object" && Array.isArray((body as any).items)) return (body as any).items;
    return [];
  },
};

export interface HttpErpConfig {
  endpoint: string;
  token?: string;
  profile?: ErpHttpProfile;
  /** Injizierbar für Tests (Default: globales fetch). */
  fetchImpl?: typeof fetch;
}

export class HttpErpAdapter implements ErpAdapter {
  private base: string;
  private token?: string;
  private profile: ErpHttpProfile;
  private fetchImpl: typeof fetch;

  constructor(cfg: HttpErpConfig) {
    this.base = cfg.endpoint.replace(/\/+$/, "");
    this.token = cfg.token;
    this.profile = cfg.profile ?? DEFAULT_JUSTIN_PROFILE;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private query(opts: ReadOptions): string {
    const p = new URLSearchParams();
    if (opts.search) p.set("q", opts.search);
    if (opts.customerId) p.set("customerId", opts.customerId);
    if (opts.status) p.set("status", opts.status);
    p.set("limit", String(clampLimit(opts.limit)));
    p.set("offset", String(clampOffset(opts.offset)));
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  private async getList(path: string, opts: ReadOptions): Promise<any[]> {
    const res = await this.fetchImpl(`${this.base}${path}${this.query(opts)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`ERP-Lesefehler ${res.status} @ ${path}`);
    const body = await res.json();
    return (this.profile.extractList ?? ((b) => (Array.isArray(b) ? b : [])))(body);
  }

  async listInvoices(opts: ReadOptions = {}): Promise<Invoice[]> {
    const raw = await this.getList(this.profile.paths.invoices, opts);
    return raw.map(this.profile.mapInvoice ?? ((r) => r as Invoice));
  }
  async listOrders(opts: ReadOptions = {}): Promise<Order[]> {
    const raw = await this.getList(this.profile.paths.orders, opts);
    return raw.map(this.profile.mapOrder ?? ((r) => r as Order));
  }
  async getOrderStatus(orderId: string): Promise<OrderStatus | undefined> {
    const path = this.profile.paths.orderStatus.replace("{id}", encodeURIComponent(orderId));
    const res = await this.fetchImpl(`${this.base}${path}`, { method: "GET", headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`ERP-Statusfehler ${res.status} @ ${path}`);
    const raw = await res.json();
    return (this.profile.mapOrderStatus ?? ((r: any) => ({
      orderId,
      number: r?.number,
      status: String(r?.status ?? "unbekannt"),
      updatedAt: r?.updatedAt,
      note: r?.note,
    })))(raw, orderId);
  }
  async listInventory(opts: ReadOptions = {}): Promise<InventoryItem[]> {
    const raw = await this.getList(this.profile.paths.inventory, opts);
    return raw.map(this.profile.mapInventory ?? ((r) => r as InventoryItem));
  }
  async createQuote(input: CreateQuoteInput): Promise<{ quoteId: string; number?: string }> {
    const res = await this.fetchImpl(`${this.base}${this.profile.paths.quotes}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`ERP-Angebot fehlgeschlagen ${res.status}`);
    const body = (await res.json()) as any;
    return { quoteId: String(body?.id ?? body?.quoteId ?? ""), number: body?.number };
  }
}
