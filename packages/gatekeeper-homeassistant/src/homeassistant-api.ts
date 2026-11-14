// Helper wrapping Home Assistant's REST and WebSocket APIs.
//
// Home Assistant exposes two complementary APIs:
//   - REST  (/api/...)      — service calls, template render, history, logbook, fire events
//   - WebSocket (/api/websocket) — registries (areas, labels, devices, entities, floors),
//     dashboards (lovelace), state subscriptions
//
// We use both. WebSocket connections are short-lived: each `withConnection()` call opens a
// connection, performs one or more commands, and closes it. This is simple and adequate for
// Phase 1; Phase 2 may add persistent WebSocket connections to support push-based hooks.

// ---------------------------------------------------------------------------
// Errors

export class HomeAssistantError extends Error {
  readonly status?: number;
  /** When true, this error indicates the LLAT is invalid or revoked. */
  readonly isAuthError: boolean;

  constructor(message: string, opts: { status?: number; isAuthError?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.isAuthError = opts.isAuthError ?? false;
  }
}

// ---------------------------------------------------------------------------
// REST API

export interface HomeAssistantCredentials {
  /** Base URL of the HA instance, with no trailing slash (e.g. "http://homeassistant.local:8123"). */
  baseUrl: string;
  /** A long-lived access token. */
  token: string;
  /**
   * Extra headers for every request to the instance (REST and the WebSocket upgrade): the
   * deployment's Cloudflare Access service token, when HA sits behind Access. Never stored with
   * the account; attached from the Worker's env by `withAccessHeaders()`.
   */
  accessHeaders?: Record<string, string>;
}

/** The Worker-level settings for an optional Cloudflare Access service token. */
export interface CfAccessEnv {
  /** Secrets: the service token pair. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  /** Comma-separated exact hostnames the token may be sent to. Unset or empty: none. */
  CF_ACCESS_HOSTS?: string;
}

/**
 * The Access service-token headers to send to the HA instance at `baseUrl`, or `undefined`. The
 * token is a deployment-wide secret while `baseUrl` is user-supplied, so it goes only to a host
 * listed in `CF_ACCESS_HOSTS` by exact (case-insensitive) hostname -- no wildcard or suffix
 * matching -- and to none when the list is unset or empty. The token is a pair; one half without
 * the other is a deployment mistake that would otherwise surface as an unexplained Access login
 * redirect on every request, so it fails here by name (never by value).
 */
export function cfAccessHeaders(env: CfAccessEnv, baseUrl: string): Record<string, string> | undefined {
  if (!!env.CF_ACCESS_CLIENT_ID !== !!env.CF_ACCESS_CLIENT_SECRET) {
    throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together (or neither).");
  }
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return undefined;
  const allowed = (env.CF_ACCESS_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!allowed.includes(hostname)) return undefined;
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  };
}

/**
 * `creds` with the deployment's Access headers attached when its host is allowed (see
 * `cfAccessHeaders`); unchanged otherwise. Every request URL is built from `creds.baseUrl`, so
 * the host checked here is the host the headers are sent to.
 */
export function withAccessHeaders(
  creds: HomeAssistantCredentials,
  env: CfAccessEnv,
): HomeAssistantCredentials {
  const accessHeaders = cfAccessHeaders(env, creds.baseUrl);
  return accessHeaders ? { ...creds, accessHeaders } : creds;
}

/**
 * The single place outbound requests to the instance pick up `creds.accessHeaders`. As a second
 * line of defence it re-checks that `requestUrl` is on the host `withAccessHeaders` approved.
 */
function applyAccessHeaders(headers: Headers, creds: HomeAssistantCredentials, requestUrl: string): Headers {
  // Workers `fetch()` sends no User-Agent, and zone WAF rules commonly block an empty one
  // before Access is even consulted.
  if (!headers.has("User-Agent")) headers.set("User-Agent", "gadgets-gatekeeper-homeassistant");
  if (!creds.accessHeaders) return headers;
  if (new URL(requestUrl).hostname !== new URL(creds.baseUrl).hostname) return headers;
  for (const [name, value] of Object.entries(creds.accessHeaders)) {
    headers.set(name, value);
  }
  return headers;
}

function joinUrl(baseUrl: string, path: string): string {
  if (path.startsWith("/")) path = path.slice(1);
  return `${baseUrl}/${path}`;
}

/** Default timeout for HTTP requests to Home Assistant. A slow / unreachable HA instance
 * otherwise stalls the Worker until the platform deadline. */
const HA_REST_TIMEOUT_MS = 15_000;

/** Default timeout for the WebSocket auth handshake. After auth, individual `send()` commands
 * are not separately timed out — long-running registry / dashboard commands legitimately take
 * a few seconds on big HA instances. If you need a per-command timeout, race manually. */
const HA_WS_AUTH_TIMEOUT_MS = 15_000;

/** Cap on the number of bytes of an HA error-response body we include in a thrown error
 * message. HA itself doesn't echo request headers, but a misbehaving reverse proxy in front
 * of HA might. We also strip any `Authorization` / `Bearer ...` substrings as a final guard
 * so the long-lived access token can never end up in error logs / UI text. */
const HA_ERROR_BODY_MAX_BYTES = 200;

function sanitizeErrorBody(text: string, creds: HomeAssistantCredentials): string {
  let clean = text.slice(0, HA_ERROR_BODY_MAX_BYTES).replace(/\s+/g, " ").trim();
  // Belt-and-suspenders: scrub anything that looks like the bearer token or an Authorization
  // header echo. We replace the literal token with [redacted-token] first, then any
  // remaining "Bearer ..." / "Authorization: ..." substrings.
  if (creds.token) {
    clean = clean.split(creds.token).join("[redacted-token]");
  }
  // Same for an echoed Access service token.
  for (const value of Object.values(creds.accessHeaders ?? {})) {
    if (value) clean = clean.split(value).join("[redacted]");
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]");
  clean = clean.replace(/Authorization\s*:\s*[^\s,;]+/gi, "Authorization: [redacted]");
  return clean;
}

async function fetchJson<T>(
  creds: HomeAssistantCredentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = joinUrl(creds.baseUrl, path);
  const headers = applyAccessHeaders(new Headers(init.headers ?? {}), creds, url);
  headers.set("Authorization", `Bearer ${creds.token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Wrap the fetch in an AbortController so we don't hold the Worker open on a slow / dead HA
  // instance. Honor a caller-supplied signal if present.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), HA_REST_TIMEOUT_MS);
  // Chain caller signal if provided.
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener("abort", () => controller.abort(init.signal!.reason));
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (e: any) {
    if (controller.signal.aborted && e?.name === "AbortError") {
      throw new HomeAssistantError(
        `Home Assistant did not respond within ${HA_REST_TIMEOUT_MS}ms (${creds.baseUrl}).`,
      );
    }
    throw new HomeAssistantError(
      `Failed to reach Home Assistant at ${creds.baseUrl}: ${e?.message ?? e}`,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (response.status === 401 || response.status === 403) {
    throw new HomeAssistantError(
      "Home Assistant rejected the access token. The token may have been revoked.",
      { status: response.status, isAuthError: true },
    );
  }
  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    const safeText = sanitizeErrorBody(rawText, creds);
    throw new HomeAssistantError(
      `Home Assistant returned HTTP ${response.status}: ${safeText || response.statusText}`,
      { status: response.status },
    );
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }
  // For template render, HA returns text/plain.
  return (await response.text()) as unknown as T;
}

export class HomeAssistantRest {
  constructor(private readonly creds: HomeAssistantCredentials) {}

  async getConfig(): Promise<any> {
    return await fetchJson(this.creds, "api/config");
  }

  async getStates(): Promise<any[]> {
    return await fetchJson(this.creds, "api/states");
  }

  async getState(entityId: string): Promise<any> {
    return await fetchJson(this.creds, `api/states/${encodeURIComponent(entityId)}`);
  }

  // NOTE: Service calls and event firing go through the WebSocket API instead of REST. See
  // HomeAssistantWebSocket.callService / .fireEvent. HA's REST endpoints for these have
  // historical quirks (target fields must be flattened at the top level of the body, area /
  // label / floor targets are unevenly supported across versions). The WebSocket call_service
  // command is HA's modern path and supports the full target shape natively.

  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    return await fetchJson(this.creds, "api/template", {
      method: "POST",
      body: JSON.stringify({ template, variables }),
    });
  }

  async getHistory(
    entityIds: string[],
    start: Date,
    end?: Date,
    minimal = true,
  ): Promise<any[][]> {
    const params = new URLSearchParams();
    params.set("filter_entity_id", entityIds.join(","));
    if (end) params.set("end_time", end.toISOString());
    if (minimal) params.set("minimal_response", "true");
    const path = `api/history/period/${start.toISOString()}?${params.toString()}`;
    return await fetchJson(this.creds, path);
  }

  async getLogbook(start: Date, end?: Date, entityId?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (end) params.set("end_time", end.toISOString());
    if (entityId) params.set("entity", entityId);
    const path = `api/logbook/${start.toISOString()}?${params.toString()}`;
    return await fetchJson(this.creds, path);
  }

  async getServices(): Promise<any[]> {
    return await fetchJson(this.creds, "api/services");
  }

  /** Quick check that the API is reachable and credentials are valid. */
  async ping(): Promise<{ message: string }> {
    return await fetchJson(this.creds, "api/");
  }
}

// ---------------------------------------------------------------------------
// WebSocket API
//
// HA's WebSocket protocol is documented at:
//   https://developers.home-assistant.io/docs/api/websocket
//
// Auth flow:
//   1. Server sends {type: "auth_required", ha_version: "..."}
//   2. Client sends {type: "auth", access_token: "..."}
//   3. Server sends {type: "auth_ok"} or {type: "auth_invalid", message: "..."}
//
// After auth, commands have an integer `id` (incrementing); results echo the id.

interface WSCommand {
  id: number;
  type: string;
  [key: string]: unknown;
}

interface WSResult {
  id: number;
  type: "result";
  success: boolean;
  result?: any;
  error?: { code: string; message: string };
}

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.pathname += "api/websocket";
  return url.toString();
}

/**
 * `new WebSocket()` cannot carry request headers, so when Access headers are configured the
 * upgrade goes through `fetch()` with `Upgrade: websocket` instead (the Workers way to open a
 * client WebSocket with headers).
 */
async function openWebSocketWithHeaders(
  wsUrl: string,
  creds: HomeAssistantCredentials,
): Promise<WebSocket> {
  const httpUrl = wsUrl.replace(/^ws/, "http");
  const headers = applyAccessHeaders(new Headers({ Upgrade: "websocket" }), creds, httpUrl);
  const response = await fetch(httpUrl, {
    headers,
    signal: AbortSignal.timeout(HA_WS_AUTH_TIMEOUT_MS),
  });
  const ws = response.webSocket;
  if (!ws) {
    await response.body?.cancel();
    throw new Error(`upgrade refused with HTTP ${response.status}`);
  }
  ws.accept();
  return ws;
}

/** Lightweight WebSocket client for Home Assistant. Holds an authenticated connection. */
export class HomeAssistantWebSocket {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  #closed = false;
  #closePromise: Promise<void>;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#closePromise = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => {
        this.#closed = true;
        for (const { reject } of this.#pending.values()) {
          reject(new HomeAssistantError("Home Assistant WebSocket closed unexpectedly."));
        }
        this.#pending.clear();
        resolve();
      });
      ws.addEventListener("error", () => {
        this.#closed = true;
        for (const { reject } of this.#pending.values()) {
          reject(new HomeAssistantError("Home Assistant WebSocket error."));
        }
        this.#pending.clear();
      });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      let msg: WSResult;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (msg.type !== "result") return;
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.success) {
        pending.resolve(msg.result);
      } else {
        pending.reject(
          new HomeAssistantError(
            `Home Assistant WS command failed (${msg.error?.code}): ${msg.error?.message}`,
          ),
        );
      }
    });
  }

  /** Open a new authenticated WebSocket connection. */
  static async connect(creds: HomeAssistantCredentials): Promise<HomeAssistantWebSocket> {
    const wsUrl = websocketUrl(creds.baseUrl);
    let ws: WebSocket;
    try {
      ws = creds.accessHeaders ? await openWebSocketWithHeaders(wsUrl, creds) : new WebSocket(wsUrl);
    } catch (e: any) {
      throw new HomeAssistantError(
        `Failed to open WebSocket to ${wsUrl}: ${e?.message ?? e}`,
      );
    }

    // We must run an auth handshake before anything else. The handshake uses raw messages
    // (without the integer id) so we wire up custom listeners temporarily.
    //
    // Race against a timeout so we don't hold the Worker open on a slow / unresponsive HA.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          try { ws.close(); } catch { /* ignore */ }
          reject(
            new HomeAssistantError(
              `Home Assistant WebSocket auth handshake did not complete within ${HA_WS_AUTH_TIMEOUT_MS}ms (${wsUrl}).`,
            ),
          );
        }, HA_WS_AUTH_TIMEOUT_MS);

        ws.addEventListener("error", () => {
          reject(new HomeAssistantError(`Home Assistant WebSocket error during auth.`));
        });
        ws.addEventListener("close", (event) => {
          reject(
            new HomeAssistantError(
              `Home Assistant WebSocket closed before auth completed: ${event.code} ${event.reason}`,
              { isAuthError: event.code === 1008 },
            ),
          );
        });

        const onMessage = (event: MessageEvent) => {
          let msg: any;
          try {
            msg = JSON.parse(typeof event.data === "string" ? event.data : "");
          } catch {
            return;
          }
          if (msg.type === "auth_required") {
            ws.send(JSON.stringify({ type: "auth", access_token: creds.token }));
          } else if (msg.type === "auth_ok") {
            ws.removeEventListener("message", onMessage);
            resolve();
          } else if (msg.type === "auth_invalid") {
            ws.removeEventListener("message", onMessage);
            reject(
              new HomeAssistantError(
                `Home Assistant rejected the access token: ${msg.message ?? "unknown"}`,
                { isAuthError: true },
              ),
            );
          }
        };
        ws.addEventListener("message", onMessage);
      });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    return new HomeAssistantWebSocket(ws);
  }

  /** Send a command and wait for the result. */
  async send<T = any>(command: Omit<WSCommand, "id">): Promise<T> {
    if (this.#closed) {
      throw new HomeAssistantError("WebSocket is closed.");
    }
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#ws.send(JSON.stringify({ ...command, id }));
    return promise;
  }

  /** Call a Home Assistant service via the WebSocket `call_service` command.
   *
   * This is the modern path and supports every target form (entity_id, device_id, area_id,
   * label_id, floor_id), unlike the REST equivalent which has historical quirks around
   * advanced targets. */
  async callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<any> {
    const cmd: Record<string, unknown> = {
      type: "call_service",
      domain,
      service,
    };
    if (serviceData && Object.keys(serviceData).length > 0) {
      cmd.service_data = serviceData;
    }
    if (target && Object.keys(target).length > 0) {
      cmd.target = target;
    }
    return await this.send(cmd as Omit<WSCommand, "id">);
  }

  /** Fire an event on the Home Assistant event bus via the WebSocket `fire_event` command. */
  async fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<any> {
    const cmd: Record<string, unknown> = {
      type: "fire_event",
      event_type: eventType,
    };
    if (eventData && Object.keys(eventData).length > 0) {
      cmd.event_data = eventData;
    }
    return await this.send(cmd as Omit<WSCommand, "id">);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
    await this.#closePromise;
  }
}

/** Convenience: open a WS connection, run a callback, then close. */
export async function withWebSocket<T>(
  creds: HomeAssistantCredentials,
  fn: (ws: HomeAssistantWebSocket) => Promise<T>,
): Promise<T> {
  const ws = await HomeAssistantWebSocket.connect(creds);
  try {
    return await fn(ws);
  } finally {
    await ws.close();
  }
}

// ---------------------------------------------------------------------------
// Combined helpers that touch both REST and WS

/** Aggregate snapshot of the HA registries, fetched in one round-trip per registry. */
export interface RegistrySnapshot {
  areas: any[];
  floors: any[];
  labels: any[];
  devices: any[];
  entities: any[];
  states: Map<string, any>;
}

export async function fetchRegistrySnapshot(
  creds: HomeAssistantCredentials,
): Promise<RegistrySnapshot> {
  const states = await new HomeAssistantRest(creds).getStates();
  const stateMap = new Map<string, any>();
  for (const s of states) {
    stateMap.set(s.entity_id, s);
  }

  return await withWebSocket(creds, async (ws) => {
    const [areas, floors, labels, devices, entities] = await Promise.all([
      ws.send<any[]>({ type: "config/area_registry/list" }),
      ws.send<any[]>({ type: "config/floor_registry/list" }).catch(() => []),
      ws.send<any[]>({ type: "config/label_registry/list" }).catch(() => []),
      ws.send<any[]>({ type: "config/device_registry/list" }),
      ws.send<any[]>({ type: "config/entity_registry/list" }),
    ]);
    return { areas, floors, labels, devices, entities, states: stateMap };
  });
}
