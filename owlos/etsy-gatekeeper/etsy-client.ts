// owlOS — Etsy-Gatekeeper: Etsy-Open-API-v3-Zugriff (OWL-1740)
//
// Kapselt Lese- und Schreibzugriff auf die Etsy Open API v3 (Base https://openapi.etsy.com).
// Reads sind direkt erlaubt (read-only, gefahrlos); Writes laufen ausschliesslich ueber
// bereits freigegebene `WriteAction`s aus der Approval-Queue (siehe write-queue.ts / worker.ts).
//
// Auth (siehe Etsy Authentication-Guide):
//   - `x-api-key: <keystring>:<shared_secret>` auf JEDEM Request.
//   - `Authorization: Bearer <access_token>` zusaetzlich fuer private/schreibende Endpoints;
//     der Access-Token kommt vom TokenManager (Refresh + Persistenz, siehe token-store.ts).
//
// Zwei Implementierungen:
//   - `EtsyApiClient`  — echter HTTP-Client (fetch injizierbar → in Tests Fake-fetch, kein Netz).
//   - Tests nutzen denselben Client mit Fake-fetch; ein Fake-CRM-artiger Memory-Store ist
//     nicht noetig, weil die Etsy-API die Datenquelle ist.
//
// Sicherheit: Pfade werden aus statischen Templates + numerisch geprueften IDs gebaut,
// Query-/Body-Werte ausschliesslich ueber URLSearchParams kodiert (kein String-Bau).

import type { EtsyTarget, WriteAction } from "./write-queue.ts";
import { FIELD_ALLOWLIST, TARGET_ENDPOINT } from "./write-queue.ts";

export const MAX_READ_LIMIT = 100;
export const DEFAULT_READ_LIMIT = 25;

export interface ListingReadOptions {
  state?: "active" | "inactive" | "sold_out" | "draft" | "expired";
  limit?: number;
  offset?: number;
}

export interface ReceiptReadOptions {
  limit?: number;
  offset?: number;
  wasPaid?: boolean;
  wasShipped?: boolean;
}

export interface ReviewReadOptions {
  limit?: number;
  offset?: number;
}

export interface EtsyStore {
  getShop(): Promise<unknown>;
  listListings(opts?: ListingReadOptions): Promise<unknown>;
  getListing(listingId: string): Promise<unknown>;
  getListingInventory(listingId: string): Promise<unknown>;
  listReceipts(opts?: ReceiptReadOptions): Promise<unknown>;
  listReviews(opts?: ReviewReadOptions): Promise<unknown>;
  /** Fuehrt eine bereits freigegebene Schreibaktion aus; liefert die Datensatz-ID. */
  applyWrite(action: WriteAction): Promise<{ id: string }>;
}

export interface EtsyClientConfig {
  /** Daten-Base, i.d.R. https://openapi.etsy.com */
  apiBase: string;
  keystring: string;
  sharedSecret: string;
  /** Numerische Shop-ID der Shop-Inhaberin. */
  shopId: string;
  /** Liefert einen gueltigen Access-Token (refresht bei Bedarf). */
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Etsy hat 429 zurueckgegeben — klarer, nicht-stiller Fehler an das MCP (kein Retry-Loop). */
export class EtsyRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "EtsyRateLimitError";
  }
}

/** Allgemeiner Etsy-API-Fehler (4xx/5xx ausser 429). */
export class EtsyApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EtsyApiError";
  }
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_READ_LIMIT;
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}
function clampOffset(offset?: number): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}
function assertNumericId(id: string, label: string): string {
  if (!/^\d+$/.test(id)) throw new EtsyApiError(`${label} muss eine numerische Etsy-ID sein.`, 400);
  return id;
}

export class EtsyApiClient implements EtsyStore {
  private readonly fetchImpl: typeof fetch;

  constructor(private config: EtsyClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private get shopId(): string {
    return assertNumericId(this.config.shopId, "shop_id");
  }

  private baseHeaders(): Record<string, string> {
    return { "x-api-key": `${this.config.keystring}:${this.config.sharedSecret}` };
  }

  /** GET-Helfer. `authed=true` haengt den OAuth-Bearer an (fuer private/scoped Endpoints). */
  private async get(path: string, query: URLSearchParams | undefined, authed: boolean): Promise<unknown> {
    const url = `${this.config.apiBase}${path}${query && [...query].length ? `?${query}` : ""}`;
    const headers = this.baseHeaders();
    if (authed) headers["Authorization"] = `Bearer ${await this.config.getAccessToken()}`;
    const resp = await this.fetchImpl(url, { method: "GET", headers });
    return this.handle(resp);
  }

  private async handle(resp: Response): Promise<unknown> {
    if (resp.status === 429) {
      const ra = resp.headers.get("Retry-After");
      const secs = ra && /^\d+$/.test(ra) ? Number(ra) : undefined;
      throw new EtsyRateLimitError(
        `Etsy-Rate-Limit erreicht (429).${secs !== undefined ? ` In ${secs}s erneut versuchen.` : " Spaeter erneut versuchen."}`,
        secs,
      );
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new EtsyApiError(`Etsy-API-Fehler (HTTP ${resp.status})${text ? `: ${text.slice(0, 300)}` : ""}`, resp.status);
    }
    if (resp.status === 204) return null;
    return resp.json().catch(() => null);
  }

  // --- Reads ---------------------------------------------------------------

  async getShop(): Promise<unknown> {
    return this.get(`/v3/application/shops/${this.shopId}`, undefined, false);
  }

  async listListings(opts: ListingReadOptions = {}): Promise<unknown> {
    const q = new URLSearchParams();
    if (opts.state) q.set("state", opts.state);
    q.set("limit", String(clampLimit(opts.limit)));
    q.set("offset", String(clampOffset(opts.offset)));
    return this.get(`/v3/application/shops/${this.shopId}/listings`, q, true);
  }

  async getListing(listingId: string): Promise<unknown> {
    const id = assertNumericId(listingId, "listing_id");
    return this.get(`/v3/application/listings/${id}`, undefined, false);
  }

  async getListingInventory(listingId: string): Promise<unknown> {
    const id = assertNumericId(listingId, "listing_id");
    return this.get(`/v3/application/listings/${id}/inventory`, undefined, true);
  }

  async listReceipts(opts: ReceiptReadOptions = {}): Promise<unknown> {
    const q = new URLSearchParams();
    q.set("limit", String(clampLimit(opts.limit)));
    q.set("offset", String(clampOffset(opts.offset)));
    if (typeof opts.wasPaid === "boolean") q.set("was_paid", String(opts.wasPaid));
    if (typeof opts.wasShipped === "boolean") q.set("was_shipped", String(opts.wasShipped));
    return this.get(`/v3/application/shops/${this.shopId}/receipts`, q, true);
  }

  async listReviews(opts: ReviewReadOptions = {}): Promise<unknown> {
    const q = new URLSearchParams();
    q.set("limit", String(clampLimit(opts.limit)));
    q.set("offset", String(clampOffset(opts.offset)));
    return this.get(`/v3/application/shops/${this.shopId}/reviews`, q, false);
  }

  // --- Write (nur nach menschlicher Freigabe) ------------------------------

  async applyWrite(action: WriteAction): Promise<{ id: string }> {
    const targetId = assertNumericId(action.targetId, action.target === "listing" ? "listing_id" : "receipt_id");
    const { method } = TARGET_ENDPOINT[action.target];

    // Defense-in-depth: hier nochmals gegen die Allowlist filtern (die Queue tat es bereits).
    const allowed = FIELD_ALLOWLIST[action.target];
    const body = new URLSearchParams();
    for (const [field, value] of Object.entries(action.data)) {
      if (!allowed[field]) continue;
      if (value === null) continue; // leere Werte nicht mitsenden
      body.set(field, String(value));
    }
    if ([...body].length === 0) throw new EtsyApiError("Keine gueltigen Felder zum Schreiben.", 400);

    const path = this.writePath(action.target, targetId);
    const headers = this.baseHeaders();
    headers["Authorization"] = `Bearer ${await this.config.getAccessToken()}`;
    headers["Content-Type"] = "application/x-www-form-urlencoded";

    const resp = await this.fetchImpl(`${this.config.apiBase}${path}`, {
      method,
      headers,
      body: body.toString(),
    });
    await this.handle(resp);
    return { id: targetId };
  }

  private writePath(target: EtsyTarget, targetId: string): string {
    switch (target) {
      case "listing":
        return `/v3/application/shops/${this.shopId}/listings/${targetId}`;
      case "receipt":
        return `/v3/application/shops/${this.shopId}/receipts/${targetId}`;
    }
  }
}
