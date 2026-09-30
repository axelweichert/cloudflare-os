/**
 * Etsy gatekeeper — Session API (DRAFT, OWL-1746).
 *
 * These interfaces are the Gadget/agent-facing API for the Etsy shop `lindanahandmade`.
 * They are designed around capability-based security: each interface is a handle to one
 * logical Etsy resource, so authority is limited simply by limiting which handle a Gadget
 * holds (a whole shop, or a single listing) and which methods it may call.
 *
 * Granularities (what a user can grant an agent):
 *   - `EtsyShop`     — the whole shop. URL: https://www.etsy.com/shop/:shopName
 *   - `EtsyListing`  — one product.   URL: https://www.etsy.com/listing/:listingId
 * Receipts (orders) are reached only through a shop handle; they are not independently
 * grantable — an order is transient and a per-order grant is not a useful unit.
 *
 * Scope: reading, plus editing existing listings and updating order fulfilment. This
 * gatekeeper never creates listings or orders. Price and quantity are read-only in this
 * version (see `EtsyListingDetails`).
 */

/**
 * A monetary amount in an Etsy shop's currency.
 *
 * `value` is the human-readable major-unit amount (e.g. `12.5` for 12.50). `currencyCode`
 * is an ISO 4217 code such as `"EUR"`.
 */
export interface EtsyMoney {
  value: number;
  currencyCode: string;
}

/**
 * An Etsy shop — the coarse-grained binding.
 *
 * From here you can read shop metadata, browse and open listings, browse and open orders
 * (receipts), and read reviews. To act on a single product or order, open it with
 * `getListing` / `getReceipt` and call methods on the returned handle.
 */
export interface EtsyShop {
  /** Returns basic public metadata about the shop. */
  getInfo(): Promise<EtsyShopInfo>;

  /**
   * Lists the shop's listings, most-recent first.
   *
   * Results are streamed through the returned cursor: call `next()` repeatedly on that same
   * cursor until it returns `null`. Use `state` to filter by publication state.
   */
  listListings(options?: EtsyListingFilter): Promise<Cursor<EtsyListingSummary>>;

  /**
   * Opens a specific listing in this shop by its numeric listing ID.
   *
   * Throws if the ID is not a listing in this shop.
   */
  getListing(listingId: string): Promise<EtsyListing>;

  /**
   * Lists the shop's orders (Etsy "receipts"), most-recent first.
   *
   * Results are streamed through the returned cursor: call `next()` repeatedly until it
   * returns `null`. Use the filters to narrow by fulfilment status.
   */
  listReceipts(options?: EtsyReceiptFilter): Promise<Cursor<EtsyReceiptSummary>>;

  /**
   * Opens a specific order in this shop by its numeric receipt ID.
   *
   * Throws if the ID is not a receipt in this shop.
   */
  getReceipt(receiptId: string): Promise<EtsyReceipt>;

  /**
   * Lists reviews left for this shop, most-recent first.
   *
   * Results are streamed through the returned cursor: call `next()` repeatedly until it
   * returns `null`.
   */
  listReviews(options?: EtsyPageOptions): Promise<Cursor<EtsyReview>>;
}

/**
 * A single Etsy listing (a product).
 *
 * This handle both reads the listing and edits its editable fields. Price and quantity are
 * **not** editable through this API and are only returned by `getDetails()`.
 */
export interface EtsyListing {
  /** Returns the listing's current details, including its (read-only) price and quantity. */
  getDetails(): Promise<EtsyListingDetails>;

  /** Replaces the listing title. Max 140 characters. */
  setTitle(title: string): Promise<void>;

  /** Replaces the listing description (plain text). */
  setDescription(description: string): Promise<void>;

  /**
   * Publishes the listing so it is visible for sale.
   *
   * Only listings currently `inactive` can be activated; a `draft`, `sold_out`, or
   * `expired` listing cannot be activated through this API.
   */
  activate(): Promise<void>;

  /**
   * Deactivates the listing so it is no longer visible for sale.
   *
   * Only an `active` listing can be deactivated.
   */
  deactivate(): Promise<void>;

  /** Turns Etsy's automatic renewal for this listing on or off. */
  setAutoRenew(enabled: boolean): Promise<void>;

  /**
   * Moves the listing into a shop section, or removes it from any section when passed
   * `null`. `shopSectionId` is a numeric section ID from this shop.
   */
  setShopSection(shopSectionId: number | null): Promise<void>;
}

/**
 * A single Etsy order (Etsy calls this a "receipt").
 *
 * This handle reads the order and updates its fulfilment status. Order contents cannot be
 * changed through this API.
 */
export interface EtsyReceipt {
  /** Returns the order's details: buyer name, line items, totals, and fulfilment status. */
  getDetails(): Promise<EtsyReceiptDetails>;

  /** Marks the order as shipped. */
  markShipped(): Promise<void>;

  /** Marks the order as paid. */
  markPaid(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Data shapes

/** Public metadata about a shop. */
export interface EtsyShopInfo {
  /** Numeric shop ID. */
  shopId: string;
  /** URL slug / handle, e.g. `"lindanahandmade"`. */
  shopName: string;
  /** Human-readable shop title. */
  title: string | null;
  /** ISO 4217 currency the shop trades in. */
  currencyCode: string;
  /** Number of currently active listings. */
  activeListingCount: number;
  /** Canonical shop URL. */
  url: string;
}

/** Publication state of a listing. */
export type EtsyListingState = "active" | "inactive" | "sold_out" | "draft" | "expired";

/** A listing as it appears in a list result. */
export interface EtsyListingSummary {
  listingId: string;
  title: string;
  state: EtsyListingState;
  price: EtsyMoney;
  /** Available quantity across all variations. */
  quantity: number;
  url: string;
}

/** Full details of a single listing. */
export interface EtsyListingDetails extends EtsyListingSummary {
  /** Plain-text description. */
  description: string;
  /** Free-form tags. */
  tags: string[];
  /** Whether Etsy auto-renews the listing when it expires. */
  autoRenew: boolean;
  /** Section this listing belongs to, or `null` if unsectioned. */
  shopSectionId: number | null;
  /** When the listing was first created. */
  createdAt: string;
}

/** Filters for listing a shop's listings. */
export type EtsyListingFilter = EtsyPageOptions & {
  state?: EtsyListingState;
};

/** An order as it appears in a list result. */
export interface EtsyReceiptSummary {
  receiptId: string;
  /** Name the buyer gave for the order. */
  buyerName: string | null;
  grandTotal: EtsyMoney;
  isPaid: boolean;
  isShipped: boolean;
  /** When the order was placed. */
  createdAt: string;
}

/** A single purchased item within an order. */
export interface EtsyReceiptItem {
  listingId: string;
  title: string;
  quantity: number;
  price: EtsyMoney;
}

/** Full details of a single order. */
export interface EtsyReceiptDetails extends EtsyReceiptSummary {
  /** Line items purchased in this order. */
  items: EtsyReceiptItem[];
  /** Optional note the buyer left for the seller. */
  buyerMessage: string | null;
}

/** A review left for the shop. */
export interface EtsyReview {
  /** Star rating, 1–5. */
  rating: number;
  /** Review text, if the buyer left any. */
  text: string | null;
  /** The listing this review is about, if still available. */
  listingId: string | null;
  createdAt: string;
}

/**
 * A pagination cursor.
 *
 * This is an RPC object. Call `next()` repeatedly on the same cursor to fetch subsequent
 * batches of results. `next()` returns `null` once exhausted. Dispose the cursor when
 * finished.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** Generic paging options for a cursor-backed result set. */
export type EtsyPageOptions = {
  /** How many results to fetch per batch (1–100). */
  resultsPerPage?: number;
};

/** Filters for listing a shop's orders. */
export type EtsyReceiptFilter = EtsyPageOptions & {
  isPaid?: boolean;
  isShipped?: boolean;
};
