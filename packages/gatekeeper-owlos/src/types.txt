// TypeScript interface for the owlOS ERP gatekeeper. These types are exposed to gadgets and agents
// that have been granted access to an owlOS ERP workspace.
//
// owlOS ERP (https://owl-os.cloud) is a real, edge-native Cloud ERP. Each customer runs their own
// owlOS instance in their *own* Cloudflare account — there is no central API host — so this
// gatekeeper connects an instance by its base URL *plus* an API token (Token-Connect, like
// gk-unifi / gk-cloudflare). The instance's HTTP API lives under `{instanceUrl}/api`:
// `/api/health` is public; every other `/api/*` requires the token.
//
// SCOPE: S1 (OWL-1641) ships the connect + verify driver and exposes the authenticated workspace
// identity. The full blueprint surface — customers, quotes/orders (Angebote/Aufträge) and invoices
// (Rechnungen) CRUD — is wired in S2 (OWL-1634) and will extend `OwlosSession`.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
// 1. All methods take POSITIONAL arguments. Never pass a single options object.
// 2. All methods are async and must be awaited.

/**
 * A connected owlOS ERP workspace, scoped to one instance + token. Read-only in S1.
 */
export interface OwlosSession {
  /**
   * The authenticated workspace identity, as returned by `GET {instanceUrl}/api/me`. The exact
   * fields are owlOS-defined; S2 (OWL-1634) narrows this once the token schema is confirmed.
   */
  me(): Promise<Record<string, unknown>>;
}
