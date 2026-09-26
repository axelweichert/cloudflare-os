// Thin READ-ONLY client over a Proxmox API (VE or PBS), reachable through the board's Cloudflared
// tunnel. Auth is a single API token string "USER@REALM!TOKENID=SECRET" sent as
//   Authorization: <PREFIX>=USER@REALM!TOKENID=SECRET
// where <PREFIX> is PRODUCT.authPrefix — "PVEAPIToken" (VE) or "PBSAPIToken" (PBS). This is the
// Token-Connect pattern (like gk-cloudflare / gk-owlos): the board pastes a finished API token at
// connect time; there is no OAuth app to register.
//
// SEAM (OWL-1681, verified 2026-09-24 by a token-free probe): both pve.weichert.at and pbs.weichert.at
// answer a bare request with `HTTP 403 cf-mitigated: challenge` — a Cloudflare **Managed Challenge**
// (bot mitigation), NOT a Cloudflare Access application (there is no redirect to *.cloudflareaccess.com).
// So NO CF-Access service token is part of this contract. If the edge ever challenges this Worker's
// own subrequest, the fix is a WAF skip rule for the /api2/json path (board/CIO), not a credential
// here. RATEN VERBOTEN: we do not add Access fields we could not observe being required.
//
// TOKEN DISCIPLINE (board: "don't burn my token"): exactly one read-only auth attempt per endpoint,
// never a scheme/format brute force. The token is never logged.
import { PRODUCT } from "./product";
import { normalizeToken, ProxmoxError } from "./token";

export { normalizeToken, ProxmoxError } from "./token";

const FETCH_TIMEOUT_MS = 15_000;

export interface ProxmoxCredentials {
  /** Full Proxmox API token: "USER@REALM!TOKENID=SECRET". */
  apiToken: string;
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `${PRODUCT.authPrefix}=${token}` };
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    // Non-JSON body (e.g. a Cloudflare challenge/interstitial HTML page): leave body null.
  }
  return { status: resp.status, body };
}

/**
 * Confirm the token authenticates against the fixed Proxmox host with ONE read-only call:
 *   GET {base}/version → 200 { data: { version, ... } }.
 * Falls back to {base}{verifyFallback} only when /version answers a non-auth error (404/501). A 401/403
 * is a definitive "bad token" and stops immediately — no retries, no format guessing.
 */
export async function verifyCredentials(apiToken: string): Promise<ProxmoxCredentials> {
  const token = normalizeToken(apiToken);
  const headers = authHeader(token);

  let res: { status: number; body: any };
  try {
    res = await fetchJson(`${PRODUCT.base}${PRODUCT.verifyPath}`, { method: "GET", headers });
  } catch (e: any) {
    throw new ProxmoxError(`Unable to reach ${PRODUCT.host}: ${e?.message ?? e}`);
  }
  if (res.status === 200 && res.body?.data) return { apiToken: token };
  if (res.status === 401 || res.status === 403) {
    // 403 here could also be the edge Managed Challenge rather than Proxmox itself — say so, so the
    // board knows the fix might be a WAF skip rule, not a new token.
    throw new ProxmoxError(
      `${PRODUCT.displayName} returned HTTP ${res.status} for GET ${PRODUCT.verifyPath}. ` +
        `Either the API token is wrong, or a Cloudflare Managed Challenge is blocking API calls to ` +
        `${PRODUCT.host} (add a WAF skip rule for ${PRODUCT.base}).`,
    );
  }

  // Non-auth failure on /version → try the documented fallback read once.
  let fb: { status: number; body: any };
  try {
    fb = await fetchJson(`${PRODUCT.base}${PRODUCT.verifyFallback}`, { method: "GET", headers });
  } catch (e: any) {
    throw new ProxmoxError(`Unable to reach ${PRODUCT.host}: ${e?.message ?? e}`);
  }
  if (fb.status === 200 && fb.body?.data !== undefined) return { apiToken: token };
  if (fb.status === 401 || fb.status === 403) {
    throw new ProxmoxError(`${PRODUCT.displayName} rejected the API token (HTTP ${fb.status}).`);
  }
  throw new ProxmoxError(
    `${PRODUCT.host} did not respond like a ${PRODUCT.displayName} API ` +
      `(GET ${PRODUCT.verifyPath} → HTTP ${res.status}, GET ${PRODUCT.verifyFallback} → HTTP ${fb.status}).`,
  );
}

/** Authenticated read-only client for the connected Proxmox host. Proxmox wraps payloads in {data}. */
export class ProxmoxClient {
  #token: string;
  constructor(creds: ProxmoxCredentials) {
    this.#token = creds.apiToken;
  }

  async get(path: string): Promise<any> {
    const { status, body } = await fetchJson(`${PRODUCT.base}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeader(this.#token) },
    });
    if (status < 200 || status >= 300) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      // Never log the token; path + status + short body only, so a live read is diagnosable in tail.
      console.warn(`${PRODUCT.vendorId} GET ${path} -> HTTP ${status} body=${(raw ?? "").slice(0, 400)}`);
      if (status === 401 || status === 403) {
        throw new ProxmoxError(`${PRODUCT.displayName} credentials are no longer valid.`);
      }
      throw new ProxmoxError(`${PRODUCT.displayName} GET ${path} returned HTTP ${status}.`);
    }
    return body?.data ?? body ?? null;
  }
}
