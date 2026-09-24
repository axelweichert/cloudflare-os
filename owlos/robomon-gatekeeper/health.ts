/**
 * Robomon-Gatekeeper — reine Ableitung von Health-/Auth-Observations (VON-1803 / K6).
 *
 * Liest den Zustand, den `von-authmon` (VON-1689) in seiner KV ablegt, und leitet
 * daraus **read-only** Beobachtungen für Status-Dashboard-Gadgets und Alarm-Triage-
 * Agenten ab. Rein observierend: es gibt keine Actions, keine Schwellen-Alarme, keine
 * Mails — das erledigt weiterhin `von-authmon`. Dieser Baustein macht denselben
 * Zustand nur für Gadgets/Agenten *lesbar* konsumierbar.
 *
 * Runtime-agnostisch: hängt nur an einfachen JSON-Objekten (der KV-Werte), nicht an
 * KV/Workers direkt → in Node/tsx testbar, im Worker mit KV-Repo.
 *
 * KV-Schema (von-authmon `STATE`, vgl. ops/authmon/src/index.js):
 *   bootAt : string  — ms-Epoch des Worker-Boots
 *   hb     : json    — letzter Heartbeat { receivedAt, today, window, tokenExpiresAt, host, ... }
 *   alarm  : json    — aktiver Alarm { kind, level, since, lastNotifiedAt } | fehlt (kein Alarm)
 */

// Schwellen 1:1 aus von-authmon übernommen, damit die abgeleitete Bewertung mit
// dem tatsächlichen Alarm-Verhalten des Monitors konsistent ist.
export const STALE_MS = 45 * 60 * 1000; // kein Heartbeat > 45 min -> Pusher/Host/Runtime down
export const FAIL_RATE_ALERT = 25; // Fehlerquote im Fenster [%] -> kritisch
export const MIN_TOTAL_FOR_RATE = 5; // unter so wenig Runs keine Quoten-Bewertung

export type HealthLevel = "OK" | "ALARM";
export type HealthKind =
  | "HEALTHY"
  | "BOOTING"
  | "NO_HEARTBEAT"
  | "STALE_HEARTBEAT"
  | "ZERO_SUCCESS"
  | "HIGH_FAILRATE";

/** Tages-Kumulativzähler aus runActivity. */
export interface RunToday {
  date?: string;
  succeeded?: number;
  failed?: number;
  total?: number;
}

/** Rollierendes Delta-Fenster seit dem vorherigen Heartbeat. */
export interface RunWindow {
  succeeded?: number;
  failed?: number;
  total?: number;
}

/** Der von von-authmon in KV abgelegte Heartbeat-Datensatz. */
export interface Heartbeat {
  receivedAt?: number;
  pusherTs?: number | null;
  today?: RunToday | null;
  window?: RunWindow | null;
  tokenExpiresAt?: number | null;
  host?: string | null;
}

/** Der von von-authmon in KV abgelegte aktive Alarm. */
export interface AuthmonAlarm {
  kind: string;
  level: string;
  since: number;
  lastNotifiedAt?: number;
}

/** Roher KV-Zustand (die drei Keys), so wie das Repo ihn liefert. */
export interface AuthmonState {
  bootAt: number | null;
  hb: Heartbeat | null;
  alarm: AuthmonAlarm | null;
}

export interface TokenObservation {
  expiresAt: string; // ISO
  expiresInHours: number; // negativ = bereits abgelaufen
  expired: boolean;
}

export interface HealthSnapshot {
  /** Zeitpunkt der Beobachtung (ISO). */
  observedAt: string;
  /** Abgeleitete Bewertung — konsistent mit von-authmon `evaluate`. */
  level: HealthLevel;
  kind: HealthKind;
  detail: string;
  /** Alter des letzten Heartbeats in Minuten (null = noch keiner). */
  heartbeatAgeMinutes: number | null;
  /** true, wenn ein frischer Heartbeat vorliegt (nicht stale). */
  heartbeatFresh: boolean;
  host: string | null;
  /** Heutige Run-Kumulativzähler. */
  runToday: RunToday | null;
  /** Rollierendes Fenster (Delta) seit vorherigem Heartbeat. */
  runWindow: RunWindow | null;
  /** OAuth-Token-Ablauf (rein informativ, kein Alarm). */
  token: TokenObservation | null;
  /**
   * Der von von-authmon persistierte aktive Alarm (falls einer offen ist).
   * Kann von der frisch abgeleiteten Bewertung abweichen, wenn der 15-min-Cron
   * noch nicht neu ausgewertet hat — beide werden bewusst mitgeführt.
   */
  authmonAlarm: AuthmonAlarm | null;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Leitet aus dem KV-Zustand die aktuelle Health-Bewertung ab. Portiert die
 * Klassifikationslogik aus von-authmon `evaluate`, aber **rein lesend** und ohne
 * jeden Seiteneffekt (kein KV-Write, keine Mail).
 */
export function deriveHealth(now: number, state: AuthmonState): HealthSnapshot {
  const { hb, alarm, bootAt } = state;
  const token = deriveToken(now, hb);
  const base = {
    observedAt: new Date(now).toISOString(),
    host: hb?.host ?? null,
    runToday: (hb?.today as RunToday | null) ?? null,
    runWindow: (hb?.window as RunWindow | null) ?? null,
    token,
    authmonAlarm: alarm,
  };

  // Kein Heartbeat: Boot-Grace vs. Dead-Man's-Switch.
  if (!hb || typeof hb.receivedAt !== "number") {
    const boot = bootAt ?? now;
    if (now - boot > STALE_MS) {
      return {
        ...base,
        level: "ALARM",
        kind: "NO_HEARTBEAT",
        detail: `Seit Boot (${round((now - boot) / 60000)} min) nie ein Heartbeat empfangen. Pusher/Host/Runtime vermutlich tot.`,
        heartbeatAgeMinutes: null,
        heartbeatFresh: false,
      };
    }
    return {
      ...base,
      level: "OK",
      kind: "BOOTING",
      detail: "Warte auf ersten Heartbeat (Grace-Period).",
      heartbeatAgeMinutes: null,
      heartbeatFresh: false,
    };
  }

  const ageMs = now - (hb.receivedAt || 0);
  const ageMin = round(ageMs / 60000);

  // Stale: Pusher/Host/Runtime ausgefallen.
  if (ageMs > STALE_MS) {
    return {
      ...base,
      level: "ALARM",
      kind: "STALE_HEARTBEAT",
      detail: `Letzter Heartbeat vor ${ageMin} min (Schwelle ${STALE_MS / 60000} min). Pusher/Host/Agent-Runtime vermutlich ausgefallen.`,
      heartbeatAgeMinutes: ageMin,
      heartbeatFresh: false,
    };
  }

  // Frischer Heartbeat -> Run-Fehler über das rollierende Fenster (Delta) bewerten.
  const w = hb.window;
  const today = hb.today || null;
  const todayStr = today
    ? `${today.succeeded ?? 0}/${today.failed ?? 0}/${today.total ?? 0}`
    : "?";
  if (w && Number(w.total) > 0) {
    const wf = Number(w.failed || 0);
    const wt = Number(w.total || 0);
    const ws = Number(w.succeeded || 0);
    const pct = wt ? round((wf * 100) / wt) : 0;
    if (wf > 0 && ws === 0 && wt >= 3) {
      return {
        ...base,
        level: "ALARM",
        kind: "ZERO_SUCCESS",
        detail: `Fenster: ${wf}/${wt} neue Runs fehlgeschlagen, 0 Erfolge. Fleet-Auth-Ausfall wahrscheinlich (vgl. VON-1688). Heute gesamt: ${todayStr}.`,
        heartbeatAgeMinutes: ageMin,
        heartbeatFresh: true,
      };
    }
    if (wt >= MIN_TOTAL_FOR_RATE && pct >= FAIL_RATE_ALERT) {
      return {
        ...base,
        level: "ALARM",
        kind: "HIGH_FAILRATE",
        detail: `Fenster: Fehlerquote ${pct}% (${wf}/${wt} neue Runs). Schwelle ${FAIL_RATE_ALERT}%. Heute gesamt: ${todayStr}.`,
        heartbeatAgeMinutes: ageMin,
        heartbeatFresh: true,
      };
    }
  }

  const winStr = w
    ? `Fenster ${Number(w.succeeded || 0)}ok/${Number(w.failed || 0)}fail`
    : "Fenster: Baseline";
  const tokenNote = token
    ? token.expired
      ? ` Token: abgelaufen vor ${round(-token.expiresInHours * 60)} min (info, kein Alarm — Runs laufen).`
      : ` Token: läuft in ${token.expiresInHours.toFixed(1)} h ab (info).`
    : "";
  return {
    ...base,
    level: "OK",
    kind: "HEALTHY",
    detail:
      (today
        ? `Heute ${today.date}: ${today.succeeded ?? 0} ok / ${today.failed ?? 0} failed / ${today.total ?? 0} total. ${winStr}.`
        : "Heartbeat frisch, keine runActivity-Daten.") + tokenNote,
    heartbeatAgeMinutes: ageMin,
    heartbeatFresh: true,
  };
}

function deriveToken(now: number, hb: Heartbeat | null): TokenObservation | null {
  const exp = hb?.tokenExpiresAt;
  if (!exp) return null;
  const hrs = (exp - now) / 3600000;
  return {
    expiresAt: new Date(exp).toISOString(),
    expiresInHours: Number(hrs.toFixed(2)),
    expired: hrs <= 0,
  };
}

/** Kompakte Einzeiler-Ampel für Dashboards. */
export function healthLine(snap: HealthSnapshot): string {
  const light = snap.level === "OK" ? "🟢" : "🔴";
  const age = snap.heartbeatAgeMinutes == null ? "–" : `${snap.heartbeatAgeMinutes}m`;
  return `${light} ${snap.kind} · hb ${age} · ${snap.detail}`;
}
