// Etsy Open API v3 HTTP wrapper for the Etsy gatekeeper (OWL-1748).
//
// Wraps the Etsy Open API v3 (https://openapi.etsy.com) and normalizes its raw responses into the
// shapes the Session API (`types.d.ts`) exposes. It is deliberately dumb: it fetches and maps, and
// leaves auth-token management to the UserAccount DO and approval/audit to the gatekeeper.
//
// Auth model (Etsy Authentication guide):
//   - `x-api-key: <keystring>` on EVERY request (the app's API key / OAuth client id).
//   - `Authorization: Bearer <access_token>` additionally on private / shop-scoped / write
//     endpoints; the access token is supplied by the caller via `getToken` (refreshed + rotated in
//     the UserAccount DO — see `token` handling there).
//
// Endpoint scoping (which calls need OAuth):
//   - Public (key only): resolve shop by name, get shop, get a single listing, list reviews.
//   - Private (key + bearer): list a shop's listings, list/get receipts, all writes.
//
// Security: paths are built from static templates plus numerically-validated IDs; query and body
// values go exclusively through URLSearchParams (never string concatenation).

import type {
  EtsyListingDetails,
  EtsyListingState,
  EtsyListingSummary,
  EtsyMoney,
  EtsyReceiptDetails,
  EtsyReceiptSummary,
  EtsyReview,
  EtsyShopInfo,
} from "./types";

export const DEFAULT_API_BASE = "https://openapi.etsy.com";
export const MAX_RESULTS_PER_PAGE = 100;
export const DEFAULT_RESULTS_PER_PAGE = 25;

/** Etsy returned 429 — surfaced as a clear, non-silent error (no retry loop here). */
export class EtsyRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "EtsyRateLimitError";
  }
}

/** A general Etsy API error (4xx/5xx other than 429). */
export class EtsyApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EtsyApiError";
  }

  /** True for statuses that mean "caller cannot see / act on this resource". */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface EtsyApiConfig {
  /** Data base, normally https://openapi.etsy.com */
  apiBase: string;
  /** App API key (keystring). Etsy v3 requires `x-api-key: <keystring>:<sharedSecret>`. */
  keystring: string;
  /** App shared secret. Etsy rejects every call with "Shared secret is required in x-api-key header" without it. */
  sharedSecret?: string;
  /** Supplies a valid OAuth access token, refreshing as needed. Omit for key-only clients. */
  getToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Raw Etsy response shapes (only the fields we consume).

interface RawMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

interface RawShop {
  shop_id: number;
  shop_name: string;
  title?: string | null;
  currency_code: string;
  listing_active_count?: number;
  url: string;
}

interface RawListing {
  listing_id: number;
  shop_id?: number;
  title: string;
  description?: string;
  state: string;
  price?: RawMoney;
  quantity?: number;
  url: string;
  tags?: string[];
  should_auto_renew?: boolean;
  shop_section_id?: number | null;
  created_timestamp?: number;
  creation_timestamp?: number;
}

interface RawTransaction {
  listing_id?: number;
  title?: string;
  quantity?: number;
  price?: RawMoney;
}

interface RawReceipt {
  receipt_id: number;
  name?: string | null;
  buyer_email?: string | null;
  grandtotal?: RawMoney;
  is_paid?: boolean;
  is_shipped?: boolean;
  created_timestamp?: number;
  message_from_buyer?: string | null;
  transactions?: RawTransaction[];
}

interface RawReview {
  rating?: number;
  review?: string | null;
  listing_id?: number | null;
  created_timestamp?: number;
}

interface RawList<T> {
  count?: number;
  results?: T[];
}

const KNOWN_STATES: readonly EtsyListingState[] = [
  "active",
  "inactive",
  "sold_out",
  "draft",
  "expired",
];

function assertNumericId(id: string, label: string): string {
  if (!/^\d+$/.test(id)) throw new EtsyApiError(`${label} must be a numeric Etsy ID.`, 400);
  return id;
}

function clampResultsPerPage(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_RESULTS_PER_PAGE;
  }
  return Math.min(Math.floor(limit), MAX_RESULTS_PER_PAGE);
}

function money(raw: RawMoney | undefined, fallbackCurrency = "EUR"): EtsyMoney {
  if (!raw || typeof raw.amount !== "number" || typeof raw.divisor !== "number" || raw.divisor === 0) {
    return { value: 0, currencyCode: raw?.currency_code ?? fallbackCurrency };
  }
  return { value: raw.amount / raw.divisor, currencyCode: raw.currency_code ?? fallbackCurrency };
}

function normalizeState(state: string): EtsyListingState {
  return (KNOWN_STATES as readonly string[]).includes(state)
    ? (state as EtsyListingState)
    : "inactive";
}

function isoFromTimestamp(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}

export class EtsyApi {
  readonly #config: EtsyApiConfig;
  readonly #fetch: typeof fetch;

  constructor(config: EtsyApiConfig) {
    this.#config = config;
    // Bind the global fetch: stored on an instance field and invoked as `this.#fetch(...)`, the
    // native fetch would receive the EtsyApi instance as `this` and the Workers runtime rejects it
    // with "Illegal invocation: function called with incorrect `this` reference" (OWL-1795).
    this.#fetch = config.fetchImpl ?? fetch.bind(globalThis);
  }

  // --- transport -----------------------------------------------------------

  async #request(
    method: string,
    path: string,
    options: { query?: URLSearchParams; body?: URLSearchParams; authed: boolean },
  ): Promise<unknown> {
    const query = options.query && [...options.query].length ? `?${options.query}` : "";
    // Etsy v3 requires the shared secret alongside the keystring: `x-api-key: <keystring>:<sharedSecret>`.
    // Without it every call 403s with "Shared secret is required in x-api-key header" (OWL-1795).
    const apiKey = this.#config.sharedSecret
      ? `${this.#config.keystring}:${this.#config.sharedSecret}`
      : this.#config.keystring;
    const headers: Record<string, string> = { "x-api-key": apiKey };
    if (options.authed) {
      if (!this.#config.getToken) {
        throw new EtsyApiError("This Etsy operation requires an authorized account.", 401);
      }
      headers["Authorization"] = `Bearer ${await this.#config.getToken()}`;
    }
    if (options.body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const resp = await this.#fetch(`${this.#config.apiBase}${path}${query}`, {
      method,
      headers,
      body: options.body ? options.body.toString() : undefined,
    });
    return this.#handle(resp);
  }

  async #handle(resp: Response): Promise<unknown> {
    if (resp.status === 429) {
      const retryAfter = resp.headers.get("Retry-After");
      const secs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
      throw new EtsyRateLimitError(
        `Etsy rate limit reached (429).${secs !== undefined ? ` Retry in ${secs}s.` : " Retry later."}`,
        secs,
      );
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      // Observability: a gatekeeper that silently swallows third-party errors is undebuggable.
      // Log status + body snippet (no credentials — Etsy error bodies are like {"error":"..."}).
      console.error(`Etsy API ${resp.status} ${resp.url}: ${text.slice(0, 300)}`);
      throw new EtsyApiError(
        `Etsy API error (HTTP ${resp.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
        resp.status,
      );
    }
    if (resp.status === 204) return null;
    return resp.json().catch(() => null);
  }

  #get(path: string, query: URLSearchParams | undefined, authed: boolean): Promise<unknown> {
    return this.#request("GET", path, { query, authed });
  }

  // --- shop ----------------------------------------------------------------

  /**
   * Resolves a shop handle (e.g. `lindanahandmade`) to its numeric shop id via the public
   * `findShops` endpoint. Key-only; no OAuth. Throws if no shop matches the exact name.
   */
  async resolveShopId(shopName: string): Promise<string> {
    const query = new URLSearchParams({ shop_name: shopName });
    const raw = (await this.#get("/v3/application/shops", query, false)) as RawList<RawShop> | null;
    const match = (raw?.results ?? []).find(
      shop => shop.shop_name?.toLowerCase() === shopName.toLowerCase(),
    ) ?? raw?.results?.[0];
    if (!match) throw new EtsyApiError(`No Etsy shop found named '${shopName}'.`, 404);
    return String(match.shop_id);
  }

  async getShop(shopId: string): Promise<EtsyShopInfo> {
    const id = assertNumericId(shopId, "shop_id");
    const raw = (await this.#get(`/v3/application/shops/${id}`, undefined, false)) as RawShop;
    return {
      shopId: String(raw.shop_id),
      shopName: raw.shop_name,
      title: raw.title ?? null,
      currencyCode: raw.currency_code,
      activeListingCount: raw.listing_active_count ?? 0,
      url: raw.url,
    };
  }

  // --- listings ------------------------------------------------------------

  async listListings(
    shopId: string,
    opts: { state?: EtsyListingState; limit?: number; offset?: number } = {},
  ): Promise<EtsyListingSummary[]> {
    const id = assertNumericId(shopId, "shop_id");
    const query = new URLSearchParams();
    if (opts.state) query.set("state", opts.state);
    query.set("limit", String(clampResultsPerPage(opts.limit)));
    query.set("offset", String(Math.max(0, Math.floor(opts.offset ?? 0))));
    const raw = (await this.#get(
      `/v3/application/shops/${id}/listings`,
      query,
      true,
    )) as RawList<RawListing> | null;
    return (raw?.results ?? []).map(listing => this.#listingSummary(listing));
  }

  async getListing(listingId: string): Promise<EtsyListingDetails> {
    const id = assertNumericId(listingId, "listing_id");
    const query = new URLSearchParams({ includes: "Tags" });
    const raw = (await this.#get(`/v3/application/listings/${id}`, query, false)) as RawListing;
    return {
      ...this.#listingSummary(raw),
      description: raw.description ?? "",
      tags: raw.tags ?? [],
      autoRenew: raw.should_auto_renew ?? false,
      shopSectionId: raw.shop_section_id ?? null,
      createdAt: isoFromTimestamp(raw.created_timestamp ?? raw.creation_timestamp),
    };
  }

  /**
   * Returns the numeric shop id that owns a listing. Used to build the shop-scoped write path for
   * a listing-granularity binding, where the shop is not known from the listing URL alone.
   */
  async getListingShopId(listingId: string): Promise<string> {
    const id = assertNumericId(listingId, "listing_id");
    const raw = (await this.#get(`/v3/application/listings/${id}`, undefined, false)) as RawListing;
    if (raw.shop_id == null) {
      throw new EtsyApiError(`Etsy listing ${id} did not report an owning shop.`, 502);
    }
    return String(raw.shop_id);
  }

  #listingSummary(raw: RawListing): EtsyListingSummary {
    return {
      listingId: String(raw.listing_id),
      title: raw.title,
      state: normalizeState(raw.state),
      price: money(raw.price),
      quantity: raw.quantity ?? 0,
      url: raw.url,
    };
  }

  /** Updates editable fields on a listing (title/description/state/auto-renew/section). */
  async updateListing(
    shopId: string,
    listingId: string,
    fields: {
      title?: string;
      description?: string;
      state?: "active" | "inactive";
      should_auto_renew?: boolean;
      shop_section_id?: number | null;
    },
  ): Promise<void> {
    const shop = assertNumericId(shopId, "shop_id");
    const listing = assertNumericId(listingId, "listing_id");
    const body = new URLSearchParams();
    if (fields.title !== undefined) body.set("title", fields.title);
    if (fields.description !== undefined) body.set("description", fields.description);
    if (fields.state !== undefined) body.set("state", fields.state);
    if (fields.should_auto_renew !== undefined) {
      body.set("should_auto_renew", String(fields.should_auto_renew));
    }
    if (fields.shop_section_id !== undefined && fields.shop_section_id !== null) {
      body.set("shop_section_id", String(fields.shop_section_id));
    }
    await this.#request("PATCH", `/v3/application/shops/${shop}/listings/${listing}`, {
      body,
      authed: true,
    });
  }

  // --- receipts ------------------------------------------------------------

  async listReceipts(
    shopId: string,
    opts: { limit?: number; offset?: number; isPaid?: boolean; isShipped?: boolean } = {},
  ): Promise<EtsyReceiptSummary[]> {
    const id = assertNumericId(shopId, "shop_id");
    const query = new URLSearchParams();
    query.set("limit", String(clampResultsPerPage(opts.limit)));
    query.set("offset", String(Math.max(0, Math.floor(opts.offset ?? 0))));
    if (typeof opts.isPaid === "boolean") query.set("was_paid", String(opts.isPaid));
    if (typeof opts.isShipped === "boolean") query.set("was_shipped", String(opts.isShipped));
    const raw = (await this.#get(
      `/v3/application/shops/${id}/receipts`,
      query,
      true,
    )) as RawList<RawReceipt> | null;
    return (raw?.results ?? []).map(receipt => this.#receiptSummary(receipt));
  }

  async getReceipt(shopId: string, receiptId: string): Promise<EtsyReceiptDetails> {
    const shop = assertNumericId(shopId, "shop_id");
    const receipt = assertNumericId(receiptId, "receipt_id");
    const raw = (await this.#get(
      `/v3/application/shops/${shop}/receipts/${receipt}`,
      undefined,
      true,
    )) as RawReceipt;
    return {
      ...this.#receiptSummary(raw),
      items: (raw.transactions ?? []).map(txn => ({
        listingId: String(txn.listing_id ?? ""),
        title: txn.title ?? "",
        quantity: txn.quantity ?? 0,
        price: money(txn.price),
      })),
      buyerMessage: raw.message_from_buyer ?? null,
    };
  }

  #receiptSummary(raw: RawReceipt): EtsyReceiptSummary {
    return {
      receiptId: String(raw.receipt_id),
      buyerName: raw.name ?? null,
      grandTotal: money(raw.grandtotal),
      isPaid: raw.is_paid ?? false,
      isShipped: raw.is_shipped ?? false,
      createdAt: isoFromTimestamp(raw.created_timestamp),
    };
  }

  /** Updates a receipt's fulfilment flags (paid / shipped). */
  async updateReceipt(
    shopId: string,
    receiptId: string,
    fields: { was_paid?: boolean; was_shipped?: boolean },
  ): Promise<void> {
    const shop = assertNumericId(shopId, "shop_id");
    const receipt = assertNumericId(receiptId, "receipt_id");
    const body = new URLSearchParams();
    if (fields.was_paid !== undefined) body.set("was_paid", String(fields.was_paid));
    if (fields.was_shipped !== undefined) body.set("was_shipped", String(fields.was_shipped));
    await this.#request("PUT", `/v3/application/shops/${shop}/receipts/${receipt}`, {
      body,
      authed: true,
    });
  }

  // --- reviews -------------------------------------------------------------

  async listReviews(
    shopId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<EtsyReview[]> {
    const id = assertNumericId(shopId, "shop_id");
    const query = new URLSearchParams();
    query.set("limit", String(clampResultsPerPage(opts.limit)));
    query.set("offset", String(Math.max(0, Math.floor(opts.offset ?? 0))));
    const raw = (await this.#get(
      `/v3/application/shops/${id}/reviews`,
      query,
      false,
    )) as RawList<RawReview> | null;
    return (raw?.results ?? []).map(review => ({
      rating: review.rating ?? 0,
      text: review.review ?? null,
      listingId: review.listing_id != null ? String(review.listing_id) : null,
      createdAt: isoFromTimestamp(review.created_timestamp),
    }));
  }
}

// ---------------------------------------------------------------------------
// OAuth token exchange / refresh (PKCE). Etsy access tokens live ~1h and refresh tokens rotate on
// every refresh, so the freshly-issued refresh token MUST be persisted (see UserAccount DO).

export const ETSY_TOKEN_ENDPOINT = "https://api.etsy.com/v3/public/oauth/token";
export const ETSY_AUTHORIZE_ENDPOINT = "https://www.etsy.com/oauth/connect";

/** Exactly the scopes signed off in OWL-1740 (security review) — no more. */
export const ETSY_SCOPES = ["shops_r", "listings_r", "transactions_r", "listings_w", "transactions_w"];

export interface EtsyTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, epoch-ms. */
  expiresAt: number;
  scope?: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export class EtsyTokenError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EtsyTokenError";
  }
}

async function requestToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  now: number,
): Promise<EtsyTokenSet> {
  let resp: Response;
  try {
    resp = await fetchImpl(ETSY_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new EtsyTokenError(
      `Etsy token request network error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // Observability: surface OAuth token failures (e.g. {"error":"invalid_grant"}); no secrets logged.
    console.error(`Etsy token ${resp.status} (${body.get("grant_type")}): ${text.slice(0, 300)}`);
    throw new EtsyTokenError(
      `Etsy token request failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
      resp.status,
    );
  }
  let data: RawTokenResponse;
  try {
    data = (await resp.json()) as RawTokenResponse;
  } catch {
    throw new EtsyTokenError("Etsy token response was not valid JSON.");
  }
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new EtsyTokenError("Etsy token response was incomplete.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // ROTATED — persist the new value.
    expiresAt: now + data.expires_in * 1000,
    scope: data.scope,
  };
}

/** Exchanges a PKCE authorization code for a token set. */
export function exchangeAuthCode(args: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<EtsyTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code: args.code,
    code_verifier: args.codeVerifier,
  });
  return requestToken(body, args.fetchImpl ?? fetch, args.now ?? Date.now());
}

/** Refreshes an access token, returning a rotated token set. */
export function refreshToken(args: {
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<EtsyTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: args.clientId,
    refresh_token: args.refreshToken,
  });
  return requestToken(body, args.fetchImpl ?? fetch, args.now ?? Date.now());
}

// --- PKCE helpers (WebCrypto; workerd-compatible) --------------------------

/** base64url without padding (RFC 7636 §A). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes → 43-char base64url (a valid PKCE verifier). */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** code_challenge = base64url(SHA-256(verifier)) — S256. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
