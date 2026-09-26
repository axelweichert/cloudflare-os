// Helper wrapping the UniFi Site Manager (Cloud) API.
//
// The Site Manager API lives at https://api.ui.com and is authenticated with an API key passed in
// the `X-API-KEY` header (create one at https://unifi.ui.com → Settings → Control Plane → API).
// It is a read-first, account-scoped view over every UniFi console (host) the key's owner can see:
//
//   GET /v1/hosts          — consoles owned by / shared with the account
//   GET /v1/hosts/{id}     — one console's detail
//   GET /v1/sites          — sites across all hosts
//   GET /v1/devices        — adopted devices, grouped by host
//
// Responses are shaped `{ httpStatusCode, data, traceId, nextToken? }`. Listing endpoints paginate
// with an opaque `nextToken`; we follow it transparently and return the flattened list.
//
// This gatekeeper is READ-ONLY: it never issues a write to UniFi. The Site Manager API does expose
// a few mutating SD-WAN endpoints, but those are out of scope for v1 (see README) — so there is no
// action/approval path here, only observations.

// ---------------------------------------------------------------------------
// Errors

export class UnifiError extends Error {
  readonly status?: number;
  /** True when the API key is invalid, revoked, or lacks access (401/403). */
  readonly isAuthError: boolean;

  constructor(message: string, opts: { status?: number; isAuthError?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.isAuthError = opts.isAuthError ?? false;
  }
}

// ---------------------------------------------------------------------------
// Credentials

export interface UnifiCredentials {
  /** A UniFi Site Manager API key, sent in the `X-API-KEY` header. */
  apiKey: string;
}

/** Fixed base URL of the UniFi Site Manager Cloud API. */
export const UNIFI_API_BASE = "https://api.ui.com";

/** The human-facing UniFi Site Manager console the binding points at. */
export const UNIFI_CONSOLE_URL = "https://unifi.ui.com";

/** Default timeout for a single HTTP request to the Site Manager API. A slow / unreachable API
 * otherwise stalls the Worker until the platform deadline. */
const UNIFI_TIMEOUT_MS = 15_000;

/** Hard cap on pages followed via `nextToken`, so a misbehaving API can't spin us forever. */
const MAX_PAGES = 50;

/** Cap on the bytes of an error-response body echoed into a thrown error message. */
const ERROR_BODY_MAX_BYTES = 200;

function sanitizeErrorBody(text: string, apiKey: string): string {
  let clean = text.slice(0, ERROR_BODY_MAX_BYTES).replace(/\s+/g, " ").trim();
  // Belt-and-suspenders: never let the key leak into logs / UI even if the API echoed it back.
  if (apiKey) clean = clean.split(apiKey).join("[redacted-key]");
  clean = clean.replace(/X-API-KEY\s*:\s*[^\s,;]+/gi, "X-API-KEY: [redacted]");
  return clean;
}

interface ApiEnvelope<T> {
  httpStatusCode?: number;
  data?: T;
  nextToken?: string;
  traceId?: string;
  message?: string;
}

async function fetchJson<T>(
  creds: UnifiCredentials,
  path: string,
  init: RequestInit = {},
): Promise<ApiEnvelope<T>> {
  const url = `${UNIFI_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers ?? {});
  headers.set("X-API-KEY", creds.apiKey);
  headers.set("Accept", "application/json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNIFI_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (e: any) {
    if (controller.signal.aborted && e?.name === "AbortError") {
      throw new UnifiError(`UniFi Site Manager API did not respond within ${UNIFI_TIMEOUT_MS}ms.`);
    }
    throw new UnifiError(`Failed to reach the UniFi Site Manager API: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new UnifiError(
      "UniFi rejected the API key. It may be invalid, revoked, or lack access to this account.",
      { status: response.status, isAuthError: true },
    );
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const safe = sanitizeErrorBody(raw, creds.apiKey);
    throw new UnifiError(
      `UniFi Site Manager API returned HTTP ${response.status}: ${safe || response.statusText}`,
      { status: response.status },
    );
  }

  return (await response.json()) as ApiEnvelope<T>;
}

/** Fetch a list endpoint, transparently following `nextToken` pagination. */
async function fetchList<T>(creds: UnifiCredentials, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const url = cursor ? `${path}${sep}nextToken=${encodeURIComponent(cursor)}` : path;
    const env = await fetchJson<T[]>(creds, url);
    if (Array.isArray(env.data)) out.push(...env.data);
    if (!env.nextToken) return out;
    cursor = env.nextToken;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client

export class UnifiClient {
  constructor(private readonly creds: UnifiCredentials) {}

  /** Verify the key works and list is reachable. Cheapest authenticated call. */
  async ping(): Promise<void> {
    // `/v1/hosts` is the smallest always-available authenticated endpoint.
    await fetchJson<unknown[]>(this.creds, "/v1/hosts");
  }

  /** List every console (host) the account can see. */
  async listHosts(): Promise<any[]> {
    return await fetchList<any>(this.creds, "/v1/hosts");
  }

  /** Get one host by id. */
  async getHost(hostId: string): Promise<any> {
    const env = await fetchJson<any>(this.creds, `/v1/hosts/${encodeURIComponent(hostId)}`);
    return env.data;
  }

  /** List every site across all hosts. */
  async listSites(): Promise<any[]> {
    return await fetchList<any>(this.creds, "/v1/sites");
  }

  /** List adopted devices. The API groups them by host; we return the raw per-host groups so the
   * session layer can flatten with host context attached. Optionally filter to one host. */
  async listDevices(hostId?: string): Promise<any[]> {
    const path = hostId ? `/v1/devices?hostIds[]=${encodeURIComponent(hostId)}` : "/v1/devices";
    return await fetchList<any>(this.creds, path);
  }
}
