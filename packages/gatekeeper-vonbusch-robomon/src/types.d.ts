// TypeScript interface for the von Busch RoboMon gatekeeper. These types are exposed to gadgets and
// agents that have been granted access to the RoboMon service-robot fleet.
//
// RoboMon (https://robomon.vonbusch.app) is von Busch's edge-native fleet-monitoring app for
// service robots (Pudu / Keenon / Gausium). It exposes a live health view of every robot, an alert
// center, a maintenance/wear tracker, an integrated ticket system, and automation rules.
//
// This gatekeeper is READ-ONLY. It never changes fleet state, tickets, maintenance records, or
// automation rules; it only reads. Every read is authorized as an observation before any data is
// returned. (Writing actions — opening/updating tickets, recording service, toggling rules — are a
// deliberately separate, later phase behind their own approval.)
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
//
// 1. **All methods take POSITIONAL arguments. Never pass a single options object.**
// 2. All methods are async and must be awaited.
// 3. IDs are opaque strings assigned by RoboMon; pass them back verbatim.
// 4. The shapes below capture the fields you will most often use. RoboMon returns additional
//    fields; they are preserved on the returned objects even though they are not all typed here.
// 5. Times are epoch milliseconds unless noted.

/** A customer site whose robots the fleet contains. */
export interface RoboMonCustomer {
  /** Opaque customer id (e.g. "cust-vb"). */
  id: string;
  /** Human-readable customer / site name. */
  name: string;
  /** City the site sits in. */
  city?: string;
  /** IATA code of the nearest Cloudflare PoP the site connects through. */
  popCode?: string;
  [k: string]: unknown;
}

/**
 * One robot with its current live state, flattened into a single convenient object (RoboMon keeps
 * inventory and live telemetry separate internally; this gatekeeper joins them for you).
 */
export interface RoboMonRobot {
  /** Opaque robot id. Pass to `getRobotHistory`. */
  id: string;
  /** Display name (e.g. "PUDU CC1 (live)"). */
  name: string;
  /** Manufacturer: "Pudu" | "Keenon" | "Gausium". */
  vendor: string;
  /** Model code (e.g. "CC1", "C40"). */
  model: string;
  /** Real hardware serial number. */
  serial?: string;
  /** Internal bay / slot id at the customer site (e.g. "A-01"). */
  slot?: string;
  /** The customer this robot belongs to. */
  customerId: string;
  /** The customer's display name, echoed for convenience. */
  customerName?: string;
  /** Coarse operational status: "online" | "offline" | "maintenance". */
  status: string;
  /** Battery charge, 0–100. */
  battery?: number;
  /** True while the robot is charging. */
  charging?: boolean;
  /** Current task label, or "—" when idle. */
  task?: string;
  /** Zone / location within the customer site. */
  zone?: string;
  /** WARP / Zero-Trust tunnel status: "connected" | "connecting" | "disconnected". */
  warp?: string;
  /** Epoch ms of the last heartbeat received from the robot. */
  lastHeartbeat?: number;
  /** Whether this robot's state is "live" (real telemetry) or "simulated" (demo). */
  source?: string;
  /** Raw run state from the vendor API (e.g. "IDLE", "BUSY"); live robots only. */
  runState?: string;
  /** True when the robot is flagged inactive / out of service in settings. */
  inactive?: boolean;
  /** Count of currently open, telemetry-derived faults on this robot. */
  openErrors?: number;
  [k: string]: unknown;
}

/** Fleet-wide roll-up counters (the KPI tiles on the dashboard). */
export interface RoboMonKpis {
  /** Total robots in scope. */
  total: number;
  /** 🟢 Reachable and fault-free. */
  online: number;
  /** Reachable = total − offline. */
  reachable: number;
  /** 🟡 At least one open warning-level fault. */
  warning: number;
  /** 🔴 At least one open critical fault. */
  error: number;
  /** ⚫ Offline / no heartbeat. */
  offline: number;
  /** ⚪ Marked inactive / out of service. */
  inactive: number;
  /** In scheduled maintenance / firmware update. */
  maintenance: number;
  /** Total open alerts across the fleet. */
  openAlerts: number;
  /** Average battery charge across the fleet, 0–100. */
  avgBattery: number;
  /** Robots currently executing a task. */
  activeTasks: number;
  /** Robots whose WARP tunnel is connected. */
  warpConnected: number;
  [k: string]: unknown;
}

/** A full fleet snapshot: KPIs plus every robot and customer in scope. */
export interface RoboMonSnapshot {
  /** Epoch ms the snapshot was taken. */
  ts: number;
  /** Fleet-wide roll-up counters. */
  kpis: RoboMonKpis;
  /** Every robot in scope, with live state joined in. */
  robots: RoboMonRobot[];
  /** Every customer in scope. */
  customers: RoboMonCustomer[];
  [k: string]: unknown;
}

/** One active alert from the alert center. */
export interface RoboMonAlert {
  /** The robot the alert is about. */
  robotId: string;
  /** The robot's display name. */
  robotName: string;
  /** The customer that owns the robot. */
  customerId: string;
  /** The customer's display name. */
  customerName: string;
  /** Human-readable robot detail line (slot · vendor model · serial). */
  detail?: string;
  /** Severity: "critical" | "warning" | "info". */
  tier: string;
  /** Machine-readable alert code (e.g. "NET_LOST"). */
  code: string;
  /** Short alert title. */
  title: string;
  /** Recommended operator action. */
  action?: string;
  /** Epoch ms the alert first fired. */
  since?: number;
  [k: string]: unknown;
}

/** The alert center: prioritised open alerts plus their counts by severity. */
export interface RoboMonAlerts {
  /** Epoch ms the view was computed. */
  ts: number;
  /** Counts by severity. */
  counts: { critical: number; warning: number; info: number };
  /** Total number of open alerts. */
  total: number;
  /** The alerts themselves, most severe first. */
  alerts: RoboMonAlert[];
  [k: string]: unknown;
}

/** A ticket in the integrated ticket system (maintenance / fault / task). */
export interface RoboMonTicket {
  /** Opaque ticket id. */
  id: string;
  /** The customer the ticket belongs to. */
  customerId: string;
  /** The robot the ticket is about, or null when it is site-wide. */
  robotId: string | null;
  /** Ticket title. */
  title: string;
  /** Ticket body / description. */
  body: string;
  /** Kind: "wartung" (maintenance) | "fehler" (fault) | "aufgabe" (task). */
  kind: string;
  /** Status: "offen" (open) | "in_arbeit" (in progress) | "erledigt" (done). */
  status: string;
  /** Priority: "niedrig" | "normal" | "hoch". */
  priority: string;
  /** Assignee label, or null. */
  assigneeLabel?: string | null;
  /** How the ticket was created: "manual" | "auto". */
  source?: string;
  /** Epoch ms the ticket was created. */
  createdAt: number;
  /** Epoch ms the ticket was last updated. */
  updatedAt: number;
  [k: string]: unknown;
}

/** A single wear-tracked part on a robot's maintenance record. */
export interface RoboMonServicePart {
  /** Opaque part key (e.g. "brush"). */
  key: string;
  /** Human-readable part label. */
  label: string;
  /** Recommended replacement interval in operating hours. */
  intervalHours?: number;
  /** Recommended replacement interval in months. */
  intervalMonths?: number;
  /** Accumulated wear in operating hours, if known. */
  wearHours?: number | null;
  /** Operating hours remaining before replacement, if known. */
  remainingHours?: number | null;
  /** Epoch ms of the recommended replace-by date. */
  replaceByTs?: number | null;
  /** Days until the recommended replacement. */
  daysUntilReplace?: number | null;
  /** Date-based status: "ok" | "due" | "overdue". */
  dateStatus?: string;
  /** Overall part status. */
  status?: string;
  [k: string]: unknown;
}

/** Maintenance / wear status for one robot. */
export interface RoboMonServiceRobot {
  /** The robot id. */
  id: string;
  /** The robot's display name. */
  name: string;
  vendor?: string;
  model?: string;
  customerId: string;
  customerName?: string;
  /** Cumulative operating hours, if known. */
  operatingHours?: number | null;
  /** Epoch ms the robot entered service, if known. */
  inServiceTs?: number | null;
  /** Epoch ms of the last recorded service, if known. */
  lastServiceTs?: number | null;
  /** Per-part wear tracking. */
  parts: RoboMonServicePart[];
  [k: string]: unknown;
}

/** Fleet-wide maintenance status. */
export interface RoboMonServiceStatus {
  /** Epoch ms the view was computed. */
  ts: number;
  /** The default service interval in months. */
  intervalMonths: number;
  /** Maintenance status per robot. */
  robots: RoboMonServiceRobot[];
  [k: string]: unknown;
}

/** An automation rule (read-only view; rules are managed inside RoboMon itself). */
export interface RoboMonAutomationRule {
  /** Opaque rule id. */
  id: string;
  /** The customer the rule applies to, or "*" for the whole fleet. */
  customerId: string;
  /** Human-readable rule label. */
  label: string;
  /** Trigger type (e.g. "battery_below", "error_present", "service_due"). */
  triggerType: string;
  /** Numeric threshold for threshold-based triggers, or null. */
  threshold?: number | null;
  /** Action the rule performs when it fires (e.g. "message"). */
  action: string;
  /** Whether the rule is currently enabled. */
  enabled: boolean;
  [k: string]: unknown;
}

/** One point in a robot's battery time series. */
export interface RoboMonHistoryPoint {
  /** Epoch ms at the start of the bucket. */
  ts: number;
  /** Average battery charge in the bucket, 0–100. */
  battery: number;
  /** Minimum battery charge in the bucket. */
  bmin: number;
  /** Maximum battery charge in the bucket. */
  bmax: number;
  /** Number of raw samples in the bucket. */
  n: number;
}

/** A robot's battery history over a time window. */
export interface RoboMonHistory {
  /** The robot id. */
  robot: string;
  /** The requested range key (e.g. "4h", "24h"). */
  range: string;
  /** The window length in milliseconds. */
  windowMs: number;
  /** The bucketed points, oldest first. */
  points: RoboMonHistoryPoint[];
}

/**
 * Whole-fleet, read-only access to the von Busch RoboMon service.
 *
 * This is the session interface a gadget receives when granted the "RoboMon Fleet" resource. It is
 * the single source for the fleet dashboard and for triage / reporting agents: live robot status,
 * the alert center, the ticket queue, maintenance/wear, and automation rules.
 */
export interface RoboMonSession {
  /** Full fleet snapshot: KPI roll-up plus every robot (with live state) and customer in scope. */
  getSnapshot(): Promise<RoboMonSnapshot>;

  /** Just the robots (with live state joined), without the surrounding snapshot. */
  listRobots(): Promise<RoboMonRobot[]>;

  /** Just the fleet-wide KPI roll-up. */
  getKpis(): Promise<RoboMonKpis>;

  /** The alert center: prioritised open alerts plus counts by severity. */
  getAlerts(): Promise<RoboMonAlerts>;

  /**
   * The ticket queue. Optionally filter by `status` ("offen" | "in_arbeit" | "erledigt") and/or
   * `kind` ("wartung" | "fehler" | "aufgabe"). Pass `undefined` for either to leave it unfiltered.
   */
  listTickets(status?: string, kind?: string): Promise<RoboMonTicket[]>;

  /** Fleet-wide maintenance / wear status, per robot and per part. */
  getServiceStatus(): Promise<RoboMonServiceStatus>;

  /** The automation rules configured for the fleet (read-only view). */
  listAutomationRules(): Promise<RoboMonAutomationRule[]>;

  /**
   * A robot's battery time series over `range` (default "4h"; other keys like "24h" are accepted and
   * clamped by the service). Returns bucketed points suitable for a sparkline.
   */
  getRobotHistory(robotId: string, range?: string): Promise<RoboMonHistory>;
}
