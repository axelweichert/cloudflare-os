// Thin READ-ONLY client over a Proxmox API (VE or PBS), reachable through the board's Cloudflared
// tunnel. Auth is a single API token string "USER@REALM!TOKENID=SECRET" sent as
//   Authorization: <PREFIX>=USER@REALM!TOKENID=SECRET
// where <PREFIX> is PRODUCT.authPrefix — "PVEAPIToken" (VE) or "PBSAPIToken" (PBS). This is the
// Token-Connect pattern (like gk-cloudflare / gk-owlos): the board pastes a finished API token at
// connect time; there is no OAuth app to register.
//
// Cloudflare Access: if the host sits behind an Access application, requests carry a service token
// as CF-Access-Client-Id / CF-Access-Client-Secret. A token entered in the connect form (stored with
// the credentials) takes precedence; otherwise the deployment-wide PROXMOX_CF_ACCESS_CLIENT_ID /
// PROXMOX_CF_ACCESS_CLIENT_SECRET secrets are used when both are set.
//
// TOKEN DISCIPLINE (board: "don't burn my token"): exactly one read-only auth attempt per endpoint,
// never a scheme/format brute force. The token is never logged. Connect failures surface one
// generic message to the user; the diagnosable cause goes to the Worker log only.
import { PRODUCT } from "./product";
import { normalizeToken, ProxmoxError, type CfAccessCredentials } from "./token";

export { normalizeCfAccess, normalizeToken, ProxmoxError, type CfAccessCredentials } from "./token";

/** The one message a failed connect shows the user; the specific cause is logged. */
export const CONNECT_ERROR_MESSAGE =
  "Die Verbindung zum Proxmox-Server ist fehlgeschlagen. Bitte prüfen Sie den API-Token. Falls der Server ein eigenes Cloudflare-Access-Service-Token verlangt, können Sie dieses zusätzlich eintragen.";

const FETCH_TIMEOUT_MS = 15_000;

export interface ProxmoxCredentials {
  /** Full Proxmox API token: "USER@REALM!TOKENID=SECRET". */
  apiToken: string;
  /** Optional per-connection Cloudflare Access service token (takes precedence over the env one). */
  cfAccess?: CfAccessCredentials;
}

/** Deployment-wide fallback Cloudflare Access service token (Worker secrets). */
export interface ProxmoxAccessEnv {
  PROXMOX_CF_ACCESS_CLIENT_ID?: string;
  PROXMOX_CF_ACCESS_CLIENT_SECRET?: string;
}

function requestHeaders(
  creds: ProxmoxCredentials,
  extra?: Record<string, string>,
  env?: ProxmoxAccessEnv,
): Record<string, string> {
  const headers: Record<string, string> = {
    // OWL-2020: a speaking User-Agent on EVERY upstream request. An empty UA is
    // blocked by WAF rule 7 ("Abnormal User-Agent Blocking") on zone weichert.at.
    "User-Agent": "CloudflareOS-Gatekeeper-Proxmox/1.0",
    Authorization: `${PRODUCT.authPrefix}=${creds.apiToken}`,
    ...extra,
  };
  if (creds.cfAccess) {
    headers["CF-Access-Client-Id"] = creds.cfAccess.clientId;
    headers["CF-Access-Client-Secret"] = creds.cfAccess.clientSecret;
    headers["X-Gk-Access-Source"] = "connection";
  } else if (env?.PROXMOX_CF_ACCESS_CLIENT_ID && env?.PROXMOX_CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.PROXMOX_CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.PROXMOX_CF_ACCESS_CLIENT_SECRET;
    headers["X-Gk-Access-Source"] = "env";
  }
  return headers;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await resp.text();
  let path = url;
  let host = "?";
  try {
    ({ pathname: path, host } = new URL(url));
  } catch {
    // Keep the raw URL for the log line.
  }
  // The Access client id is an identifier, not a secret; its prefix tells which token was sent.
  const sent = new Headers(init.headers);
  const accessId = `${sent.get("CF-Access-Client-Id")?.slice(0, 8) ?? "none"}/${sent.get("X-Gk-Access-Source") ?? "-"}`;
  console.log(`[${PRODUCT.vendorId}] upstream ${init?.method ?? "GET"} ${host}${path} access=${accessId} -> HTTP ${resp.status} body=${text.slice(0, 200)}`);
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
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
export async function verifyCredentials(
  apiToken: string,
  cfAccess: CfAccessCredentials | undefined,
  env?: ProxmoxAccessEnv,
): Promise<ProxmoxCredentials> {
  const creds: ProxmoxCredentials = { apiToken: normalizeToken(apiToken), cfAccess };
  const headers = requestHeaders(creds, undefined, env);

  let res: { status: number; body: any };
  try {
    res = await fetchJson(`${PRODUCT.base}${PRODUCT.verifyPath}`, { method: "GET", headers });
  } catch (e: any) {
    console.warn(`[${PRODUCT.vendorId}] verify: ${PRODUCT.host} unreachable on GET ${PRODUCT.verifyPath}: ${e?.message ?? e}`);
    throw new ProxmoxError(CONNECT_ERROR_MESSAGE);
  }
  if (res.status === 200 && res.body?.data) return creds;
  if (res.status === 401 || res.status === 403) {
    // 403 here could also be Cloudflare Access or the edge Managed Challenge rather than Proxmox
    // itself — log every likely cause, so the board knows where the fix lies.
    const accessHint = cfAccess
      ? `the Access service token is not allowed by a Service-Auth policy on the ${PRODUCT.host} Access app`
      : `${PRODUCT.host} is behind Cloudflare Access and needs a service token (Client ID + Secret)`;
    console.warn(
      `[${PRODUCT.vendorId}] verify: GET ${PRODUCT.verifyPath} -> HTTP ${res.status}. Likely causes: the API token is wrong; ` +
        `${accessHint}; or a Cloudflare Managed Challenge / WAF rule is blocking API calls to ${PRODUCT.host} ` +
        `(needs a WAF skip for ${PRODUCT.base}).`,
    );
    throw new ProxmoxError(CONNECT_ERROR_MESSAGE);
  }

  // Non-auth failure on /version → try the documented fallback read once.
  let fb: { status: number; body: any };
  try {
    fb = await fetchJson(`${PRODUCT.base}${PRODUCT.verifyFallback}`, { method: "GET", headers });
  } catch (e: any) {
    console.warn(`[${PRODUCT.vendorId}] verify: ${PRODUCT.host} unreachable on GET ${PRODUCT.verifyFallback}: ${e?.message ?? e}`);
    throw new ProxmoxError(CONNECT_ERROR_MESSAGE);
  }
  if (fb.status === 200 && fb.body?.data !== undefined) return creds;
  if (fb.status === 401 || fb.status === 403) {
    console.warn(`[${PRODUCT.vendorId}] verify: credentials rejected (GET ${PRODUCT.verifyFallback} -> HTTP ${fb.status}).`);
    throw new ProxmoxError(CONNECT_ERROR_MESSAGE);
  }
  console.warn(
    `[${PRODUCT.vendorId}] verify: ${PRODUCT.host} did not respond like a ${PRODUCT.displayName} API ` +
      `(GET ${PRODUCT.verifyPath} -> HTTP ${res.status}, GET ${PRODUCT.verifyFallback} -> HTTP ${fb.status}).`,
  );
  throw new ProxmoxError(CONNECT_ERROR_MESSAGE);
}

/** Authenticated read-only client for the connected Proxmox host. Proxmox wraps payloads in {data}. */
export class ProxmoxClient {
  #creds: ProxmoxCredentials;
  #env: ProxmoxAccessEnv | undefined;
  constructor(creds: ProxmoxCredentials, env?: ProxmoxAccessEnv) {
    this.#creds = creds;
    this.#env = env;
  }

  async get(path: string): Promise<any> {
    const { status, body } = await fetchJson(`${PRODUCT.base}${path}`, {
      method: "GET",
      headers: requestHeaders(this.#creds, { Accept: "application/json" }, this.#env),
    });
    if (status < 200 || status >= 300) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      // Never log the token; path + status + short body only, so a live read is diagnosable in tail.
      console.warn(`${PRODUCT.vendorId} GET ${path} -> HTTP ${status} body=${(raw ?? "").slice(0, 400)}`);
      if (status === 401 || status === 403) {
        throw new ProxmoxError(`Die Zugangsdaten für ${PRODUCT.displayName} sind nicht mehr gültig.`);
      }
      throw new ProxmoxError(`Der Lesezugriff auf ${PRODUCT.displayName} ist fehlgeschlagen (Details siehe Worker-Log).`);
    }
    return body?.data ?? body ?? null;
  }
}
