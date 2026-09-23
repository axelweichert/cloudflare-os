// Thin client over a tenant's owlOS Cloud ERP HTTP API. owlOS runs in each customer's *own*
// Cloudflare account (there is no central api.owl-os.cloud host), so the connected credential is an
// instance base URL *plus* an API token — not a token alone. Verified live against the public demo
// (`demo.owl-os.cloud`, OWL-1641/1647):
//   - `GET /api/health` is public → `{ok,app:"owlos-cloud-erp",version,env}`.
//   - The auth middleware runs BEFORE routing: EVERY `/api/*` (even a made-up path) returns
//     `401 {"error":"unauthorized"}` unauthenticated. So a 401 on an arbitrary path proves nothing
//     about whether that route exists.
//   - `GET /api/auth/me` is the one authed endpoint whitelisted from the catch-all: unauthenticated
//     it returns the DISTINCT `401 {"authenticated":false}`. It is the real identity endpoint the
//     owlOS SPA itself polls, so it is the correct 401→200 probe here (NOT `/api/me`, which is just
//     the catch-all).
//
// AUTH SCHEME: the live owlOS SPA authenticates with an email+password login → session cookie
// (`credentials:"include"`); a self-service API-token issuance screen is NOT present in the live
// customer app, and no demo token could be minted headless to read back the exact header name.
// Rather than guess Bearer vs X-API-Key (RATEN VERBOTEN), the connect flow probes BOTH against the
// live instance and persists whichever one the instance answers 200 to — `verifyCredentials()` never
// returns a scheme it did not see accepted, so nothing is guessed. OPEN: whether owlOS grants API
// access via a header token at all (vs cookie-only) is unconfirmed until a real token exists — that
// is the OWL-1647 blocker, resolved by the owlOS owner supplying one token. S2 (OWL-1634) then
// hard-codes the confirmed scheme + endpoints.

// ponytail: local copy of workshop-shared's stripTrailingSlashes (a 3-liner). Kept local so this
// driver has zero runtime imports and stays unit-testable under plain node — importing it from
// workshop-shared/gatekeeper transitively pulls in `cloudflare:workers`, which only loads in-runtime.
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) --end;
  return end === value.length ? value : value.slice(0, end);
}

export type AuthScheme = "bearer" | "apikey";

export interface OwlosCredentials {
  /** Instance root, e.g. "https://demo.owl-os.cloud". No trailing slash, no "/api". */
  instanceUrl: string;
  apiToken: string;
  authScheme: AuthScheme;
}

const HEALTH_APP_ID = "owlos-cloud-erp";
const FETCH_TIMEOUT_MS = 15_000;

/** Auth header for a given scheme. */
function authHeader(scheme: AuthScheme, token: string): Record<string, string> {
  return scheme === "bearer"
    ? { Authorization: `Bearer ${token}` }
    : { "X-API-Key": token };
}

/** Normalize a user-entered instance URL to an https root with no trailing slash or "/api" suffix. */
export function normalizeInstanceUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new OwlosError("An instance URL is required.");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OwlosError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new OwlosError("The instance URL must use https.");
  }
  // Keep only origin + path; drop a trailing "/api" so both "https://x" and "https://x/api" work.
  let base = stripTrailingSlashes(url.origin + url.pathname);
  if (base.toLowerCase().endsWith("/api")) base = base.slice(0, -"/api".length);
  return stripTrailingSlashes(base);
}

export class OwlosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwlosError";
  }
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    // Non-JSON body (e.g. a Cloudflare Access login page): leave body null.
  }
  return { status: resp.status, body };
}

/**
 * Confirm the instance is a real, reachable owlOS ERP and the token authenticates.
 *   1. GET {base}/api/health must report app === "owlos-cloud-erp".
 *   2. GET {base}/api/auth/me must go 401→200 under Bearer or X-API-Key; the accepted scheme is returned.
 * Throws OwlosError with a user-facing message on any failure.
 */
export async function verifyCredentials(
  instanceUrl: string,
  apiToken: string,
): Promise<OwlosCredentials> {
  const base = normalizeInstanceUrl(instanceUrl);

  let health: { status: number; body: any };
  try {
    health = await fetchJson(`${base}/api/health`, { method: "GET" });
  } catch (e: any) {
    throw new OwlosError(`Unable to reach ${base}: ${e?.message ?? e}`);
  }
  if (health.status !== 200 || health.body?.app !== HEALTH_APP_ID) {
    throw new OwlosError(
      `${base} does not look like an owlOS instance ` +
        `(expected /api/health app "${HEALTH_APP_ID}", got ${health.body?.app ?? `HTTP ${health.status}`}).`,
    );
  }

  // Probe the token. Try each scheme; the first that authenticates wins.
  for (const scheme of ["bearer", "apikey"] as const) {
    let me: { status: number; body: any };
    try {
      me = await fetchJson(`${base}/api/auth/me`, { method: "GET", headers: authHeader(scheme, apiToken) });
    } catch (e: any) {
      throw new OwlosError(`Unable to reach ${base}: ${e?.message ?? e}`);
    }
    if (me.status === 200) return { instanceUrl: base, apiToken, authScheme: scheme };
    // 401/403 → wrong scheme or bad token; try the next scheme, then fail.
  }
  throw new OwlosError(
    "owlOS rejected the API token. Check that the token is valid for this instance and try again.",
  );
}

/** Authenticated client for a connected owlOS instance. */
export class OwlosClient {
  #creds: OwlosCredentials;

  constructor(creds: OwlosCredentials) {
    this.#creds = creds;
  }

  #headers(): Record<string, string> {
    return { Accept: "application/json", ...authHeader(this.#creds.authScheme, this.#creds.apiToken) };
  }

  /** GET {base}/api/auth/me — the authenticated workspace identity. Shape is passthrough (S2 types it). */
  async me(): Promise<Record<string, unknown>> {
    const { status, body } = await fetchJson(`${this.#creds.instanceUrl}/api/auth/me`, {
      method: "GET",
      headers: this.#headers(),
    });
    if (status === 401 || status === 403) {
      throw new OwlosError("owlOS credentials are no longer valid.");
    }
    if (status !== 200) throw new OwlosError(`owlOS /api/auth/me returned HTTP ${status}.`);
    return (body ?? {}) as Record<string, unknown>;
  }
}
