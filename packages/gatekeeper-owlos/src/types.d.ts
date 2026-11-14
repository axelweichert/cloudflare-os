// TypeScript interface for the owlOS ERP gatekeeper. These types are exposed to gadgets and agents
// that have been granted access to an owlOS ERP workspace.
//
// owlOS ERP (https://owl-os.cloud) is a real, edge-native Cloud ERP. Each customer runs their own
// owlOS instance in their *own* Cloudflare account — there is no central API host — so this
// gatekeeper connects an instance by its base URL *plus* an API token (Token-Connect, like
// gk-unifi / gk-cloudflare). The instance's HTTP API lives under `{instanceUrl}/api`:
// `/api/health` is public; every other `/api/*` requires the token.
//
// SCOPE: S1 (OWL-1641) shipped the connect + verify driver and `me()`. S2 (OWL-1634/OWL-1662) adds
// the blueprint surface — customers, quotes/orders (Angebote), invoices (Rechnungen), and CRM
// (contacts/activities/deals). Every route below is locked in packages/gatekeeper-owlos/
// S2-CONTRACT.md (extracted from the live owlOS SPA) — nothing is guessed.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
// 1. All methods take POSITIONAL arguments. Never pass a single options object.
// 2. All methods are async and must be awaited.
// 3. READS (`list*`, `me`) run immediately and return owlOS data directly.
// 4. WRITES (`create*`, `update*`, `assign*`, `merge*`, `add*`, `set*`, `finalize*`) are
//    APPROVAL-GATED: they queue the change for a human to approve and return
//    `{ status: "pending_approval", actionId }` right away. owlOS is only modified after approval —
//    do not assume a write took effect, and do not re-read to "confirm" it in the same turn.
// 5. `fields` objects are passed to owlOS verbatim. Only send the fields owlOS documents for that
//    route (see the blueprint prompt / S2-CONTRACT.md). Do not invent field names or values.

/** The pending-approval receipt returned by every write method. */
export interface OwlosPendingAction {
  status: "pending_approval";
  actionId: number;
}

/**
 * A connected owlOS ERP workspace, scoped to one instance + token.
 */
export interface OwlosSession {
  /** The authenticated workspace identity (`GET /api/auth/me`). */
  me(): Promise<Record<string, unknown>>;

  // ---- Angebot (quote): GET/POST /api/erp/quotes, PATCH /api/erp/quotes/{id} ----
  /** List quotes/offers (`GET /api/erp/quotes`). */
  listQuotes(): Promise<unknown>;
  /** Create a quote (`POST /api/erp/quotes`). `fields.title` is required ("Titel ist Pflicht"). */
  createQuote(fields: Record<string, unknown>): Promise<OwlosPendingAction>;
  /** Update a quote, e.g. set `company_id`/`status`/`valid_until` (`PATCH /api/erp/quotes/{id}`). */
  updateQuote(quoteId: string, fields: Record<string, unknown>): Promise<OwlosPendingAction>;

  // ---- Kunde (company): GET/POST /api/companies ----
  /** List customers/companies (`GET /api/companies`). */
  listCompanies(): Promise<unknown>;
  /** Create a company (`POST /api/companies`). `fields.name` is required. */
  createCompany(fields: Record<string, unknown>): Promise<OwlosPendingAction>;
  /** Assign a customer number (`POST /api/companies/assign-kundennr`). */
  assignCustomerNumber(fields: Record<string, unknown>): Promise<OwlosPendingAction>;

  // ---- Rechnung (outgoing invoice): /api/faktura/outgoing (+items/finalize) ----
  /** List outgoing invoices (`GET /api/faktura/outgoing`). */
  listInvoices(): Promise<unknown>;
  /** Create an invoice header (`POST /api/faktura/outgoing`; `doc_type` defaults to invoice). */
  createInvoice(fields: Record<string, unknown>): Promise<OwlosPendingAction>;
  /** Add line items to an invoice (`POST /api/faktura/outgoing/{id}/items`). */
  addInvoiceItems(invoiceId: string, fields: Record<string, unknown>): Promise<OwlosPendingAction>;
  /** Finalize/commit an invoice (`POST /api/faktura/outgoing/{id}/finalize`). Irreversible. */
  finalizeInvoice(invoiceId: string): Promise<OwlosPendingAction>;

  // ---- Ansprechpartner (contact): /api/contacts ----
  /** List contacts (`GET /api/contacts`). Optional filter: `company_id`, `search`, `limit`. */
  listContacts(filter?: Record<string, string | number>): Promise<unknown>;
  /** Create a contact (`POST /api/contacts`). `company_id`+`first_name`+`last_name` required. */
  createContact(fields: Record<string, unknown>): Promise<OwlosPendingAction>;
  /** Merge duplicate contacts (`POST /api/contacts/merge`). */
  mergeContacts(fields: Record<string, unknown>): Promise<OwlosPendingAction>;

  // ---- Aktivität (activity): /api/activities ----
  /** List activities (`GET /api/activities`). Optional filter: `company_id`, `contact_id`, etc. */
  listActivities(filter?: Record<string, string | number>): Promise<unknown>;
  /** Create an activity (`POST /api/activities`). `subject`+`owner_id` required. */
  createActivity(fields: Record<string, unknown>): Promise<OwlosPendingAction>;
  /** Change an activity's status (`PATCH /api/activities/{id}/status`). */
  setActivityStatus(activityId: string, fields: Record<string, unknown>): Promise<OwlosPendingAction>;

  // ---- Opportunity (deal): /api/deals ----
  /** List deals/opportunities (`GET /api/deals`). Optional filter: `company_id`, `status`, etc. */
  listDeals(filter?: Record<string, string | number>): Promise<unknown>;
  /** Create a deal (`POST /api/deals`). `title`+`owner_id` required. */
  createDeal(fields: Record<string, unknown>): Promise<OwlosPendingAction>;
}
