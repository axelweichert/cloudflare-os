// Helper wrapping the von Busch RoboMon REST API.
//
// RoboMon lives at https://robomon.vonbusch.app (Hono on Cloudflare Workers). Its auth model is a
// single opaque bearer token per account, of which only the SHA-256 hash is stored server-side
// (see robo-mon/src/auth.ts). A request with NO token resolves to the read-only "viewer" role,
// which sees the whole fleet read-only — that is the intended access level for this read-only
// gatekeeper, so a token is OPTIONAL. Supplying a "service"-role token additionally attributes the
// traffic and (for scoped roles) narrows the visible customers, but grants no write access here.
//
// This gatekeeper is READ-ONLY: it only calls GET endpoints. It never writes to RoboMon.
//
// Relevant read endpoints:
//   GET /api/whoami            — resolve role / customer scope of the current token
//   GET /api/snapshot          — full fleet snapshot (robots, states, kpis, customers)
//   GET /api/alerts            — alert center (counts + prioritised alerts)
//   GET /api/tickets           — ticket queue (?status= &kind=)
//   GET /api/service           — maintenance / wear status per robot
//   GET /api/automation/rules  — automation rules (read)
//   GET /api/history           — a robot's battery time series (?robot= &range=)

import type {
  RoboMonAlerts,
  RoboMonAutomationRule,
  RoboMonCustomer,
  RoboMonHistory,
  RoboMonKpis,
  RoboMonRobot,
  RoboMonServiceStatus,
  RoboMonSnapshot,
  RoboMonTicket,
} from "./types";

// ---------------------------------------------------------------------------
// Errors

export class RoboMonError extends Error {
  readonly status?: number;
  /** True when the token is invalid / rejected (401/403). */
  readonly isAuthError: boolean;

  constructor(message: string, opts: { status?: number; isAuthError?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.isAuthError = opts.isAuthError ?? false;
  }
}

// ---------------------------------------------------------------------------
// Credentials

export interface RoboMonCredentials {
  /**
   * Optional RoboMon bearer token, sent in the `Authorization: Bearer` header. An empty string
   * means "no token" → the read-only viewer role (whole fleet, read-only).
   */
  token: string;
}

/** Fixed base URL of the RoboMon API (also the human-facing dashboard). */
export const ROBOMON_BASE_URL = "https://robomon.vonbusch.app";

/** Default per-request timeout, so a slow / unreachable API cannot stall the Worker. */
const ROBOMON_TIMEOUT_MS = 15_000;

/** Cap on the bytes of an error-response body echoed into a thrown error message. */
const ERROR_BODY_MAX_BYTES = 200;

function sanitizeErrorBody(text: string, token: string): string {
  let clean = text.slice(0, ERROR_BODY_MAX_BYTES).replace(/\s+/g, " ").trim();
  // Belt-and-suspenders: never let the token leak into logs / UI even if the API echoed it back.
  if (token) clean = clean.split(token).join("[redacted-token]");
  return clean;
}

// ---------------------------------------------------------------------------
// whoami shape

export interface RoboMonWhoami {
  role: string;
  customerId: string | null;
  customerIds: string[] | null;
  label: string | null;
}

// ---------------------------------------------------------------------------
// Raw server shapes we join / normalise (kept local; the agent-facing shapes live in types.d.ts).

interface RawRobot {
  id: string;
  name: string;
  vendor: string;
  model: string;
  serial?: string;
  slot?: string;
  customerId: string;
  [k: string]: unknown;
}

interface RawState {
  robotId: string;
  status: string;
  battery: number;
  charging: boolean;
  task: string;
  zone: string;
  warp: string;
  lastHeartbeat: number;
  source?: string;
  runState?: string;
  inactive?: boolean;
  errors?: unknown[];
  alerts?: unknown[];
  [k: string]: unknown;
}

interface RawSnapshot {
  ts: number;
  kpis: RoboMonKpis;
  robots: RawRobot[];
  states: Record<string, RawState>;
  customers: RoboMonCustomer[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// HTTP

async function fetchJson<T>(
  creds: RoboMonCredentials,
  path: string,
): Promise<T> {
  const url = `${ROBOMON_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers({ Accept: "application/json" });
  if (creds.token) headers.set("Authorization", `Bearer ${creds.token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOMON_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (e: any) {
    if (controller.signal.aborted && e?.name === "AbortError") {
      throw new RoboMonError(`RoboMon API did not respond within ${ROBOMON_TIMEOUT_MS}ms.`);
    }
    throw new RoboMonError(`Failed to reach the RoboMon API: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new RoboMonError(
      "RoboMon rejected the token. It may be invalid, revoked, or lack access to the fleet.",
      { status: response.status, isAuthError: true },
    );
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const safe = sanitizeErrorBody(raw, creds.token);
    throw new RoboMonError(
      `RoboMon API returned HTTP ${response.status}: ${safe || response.statusText}`,
      { status: response.status },
    );
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Join inventory + live state into the flattened agent-facing robot shape.

function joinRobots(snap: RawSnapshot): RoboMonRobot[] {
  const customerName = new Map(snap.customers.map((c) => [c.id, c.name]));
  return snap.robots.map((r) => {
    const s = snap.states[r.id];
    const openErrors = s
      ? (Array.isArray(s.errors) ? s.errors.length : Array.isArray(s.alerts) ? s.alerts.length : 0)
      : 0;
    return {
      id: r.id,
      name: r.name,
      vendor: r.vendor,
      model: r.model,
      serial: r.serial,
      slot: r.slot,
      customerId: r.customerId,
      customerName: customerName.get(r.customerId),
      status: s?.status ?? "offline",
      battery: s?.battery,
      charging: s?.charging,
      task: s?.task,
      zone: s?.zone,
      warp: s?.warp,
      lastHeartbeat: s?.lastHeartbeat,
      source: s?.source,
      runState: s?.runState,
      inactive: s?.inactive,
      openErrors,
    } satisfies RoboMonRobot;
  });
}

// ---------------------------------------------------------------------------
// Client

export class RoboMonClient {
  constructor(private readonly creds: RoboMonCredentials) {}

  /** Resolve the role / customer scope the current token grants. Cheapest authenticated call. */
  async whoami(): Promise<RoboMonWhoami> {
    return await fetchJson<RoboMonWhoami>(this.creds, "/api/whoami");
  }

  /** Verify the API is reachable and the token (if any) is accepted. */
  async ping(): Promise<RoboMonWhoami> {
    return await this.whoami();
  }

  /** Full fleet snapshot with inventory and live state joined into flattened robots. */
  async getSnapshot(): Promise<RoboMonSnapshot> {
    const raw = await fetchJson<RawSnapshot>(this.creds, "/api/snapshot");
    return {
      ...raw,
      ts: raw.ts,
      kpis: raw.kpis,
      customers: raw.customers,
      robots: joinRobots(raw),
    };
  }

  async listRobots(): Promise<RoboMonRobot[]> {
    return (await this.getSnapshot()).robots;
  }

  async getKpis(): Promise<RoboMonKpis> {
    return (await this.getSnapshot()).kpis;
  }

  async getAlerts(): Promise<RoboMonAlerts> {
    return await fetchJson<RoboMonAlerts>(this.creds, "/api/alerts");
  }

  async listTickets(status?: string, kind?: string): Promise<RoboMonTicket[]> {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (kind) qs.set("kind", kind);
    const path = qs.toString() ? `/api/tickets?${qs}` : "/api/tickets";
    const res = await fetchJson<{ tickets: RoboMonTicket[] }>(this.creds, path);
    return res.tickets ?? [];
  }

  async getServiceStatus(): Promise<RoboMonServiceStatus> {
    return await fetchJson<RoboMonServiceStatus>(this.creds, "/api/service");
  }

  async listAutomationRules(): Promise<RoboMonAutomationRule[]> {
    const res = await fetchJson<{ rules: RoboMonAutomationRule[] }>(
      this.creds,
      "/api/automation/rules",
    );
    return res.rules ?? [];
  }

  async getRobotHistory(robotId: string, range?: string): Promise<RoboMonHistory> {
    const qs = new URLSearchParams({ robot: robotId });
    if (range) qs.set("range", range);
    return await fetchJson<RoboMonHistory>(this.creds, `/api/history?${qs}`);
  }
}
