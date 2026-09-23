// TypeScript interface for the owlOS ERP gatekeeper. These types are exposed to gadgets and
// agents that have been granted access to an owlOS ERP workspace.
//
// owlOS ERP is owlOS's own edge-native ERP surface (Angebote/Aufträge, Rechnungen, Kunden). It
// runs *inside* this gatekeeper (self-backed D1) — there is no external HTTP API to call. Access
// is gated by a workspace API token entered through the connect tile (Token-Connect, wie
// gk-unifi/gk-cloudflare).
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
// 1. All methods take POSITIONAL arguments. Never pass a single options object.
// 2. All methods are async and must be awaited.
// 3. IDs are opaque strings assigned by owlOS; pass them back verbatim.
// 4. Amounts (`betrag`) are in EUR as plain numbers.

/** A customer in the owlOS ERP. */
export interface Kunde {
  id: string;
  name?: string;
  firma?: string;
  email?: string;
  telefon?: string;
  /** USt-IdNr. */
  ustid?: string;
  status?: string;
}

/** A quote (`status: "angebot"`) that becomes an order once accepted (`status: "auftrag"`). */
export interface Angebot {
  id: string;
  kunde_id?: string;
  titel?: string;
  betrag?: number;
  /** "angebot" | "auftrag" | "storniert" */
  status?: string;
  gueltig_bis?: string;
}

/** An invoice. An *open item* ("offener Posten") is a Rechnung with `status: "offen"`. */
export interface Rechnung {
  id: string;
  kunde_id?: string;
  angebot_id?: string;
  nummer?: string;
  betrag?: number;
  /** "offen" | "bezahlt" | "storniert" */
  status?: string;
  faellig_am?: string;
  bezahlt_am?: string;
}

/**
 * The owlOS ERP session, scoped to one connected workspace.
 *
 * Covers the three board-approved blueprints (OWL-1631):
 *   1. Angebot/Auftrag anlegen  → `createAngebot` / `setAngebotStatus`
 *   2. Rechnung erzeugen        → `createRechnung`
 *   3. Kunde + offene Posten lesen → `listKunden` / `getKunde` / `listOffenePosten`
 */
export interface OwlosSession {
  // --- Blueprint 3: read customers + open items -------------------------------------
  /** List customers, optionally filtered by a free-text search over name/firma/email. */
  listKunden(search?: string, limit?: number): Promise<Kunde[]>;
  /** Fetch a single customer by id, or undefined if it does not exist. */
  getKunde(id: string): Promise<Kunde | undefined>;
  /** List open invoices (offene Posten) for a customer — Rechnungen with status "offen". */
  listOffenePosten(kundeId: string, limit?: number): Promise<Rechnung[]>;

  // --- Blueprint 1: create quote/order ----------------------------------------------
  /** Create a new quote (Angebot) for a customer. Returns the new id. */
  createAngebot(kundeId: string, titel: string, betrag: number, gueltigBis?: string): Promise<{ id: string }>;
  /** Promote/cancel a quote: set its status to "auftrag" (accepted) or "storniert". */
  setAngebotStatus(id: string, status: "auftrag" | "storniert"): Promise<void>;

  // --- Blueprint 2: create invoice --------------------------------------------------
  /** Create an invoice for a customer (optionally linked to an Angebot). Returns the new id. */
  createRechnung(kundeId: string, betrag: number, nummer: string, faelligAm?: string, angebotId?: string): Promise<{ id: string }>;
}
