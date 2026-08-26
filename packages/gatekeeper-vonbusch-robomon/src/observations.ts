/**
 * Beobachtungs-Kern des Robomon-Gadgets (VON-1814 / Port von K6 VON-1803).
 *
 * Runtime-agnostisch und ohne `cloudflare:workers`/`capnweb`-Import: die Klasse hängt nur
 * an der `RobomonSession` (read-only Fach-Logik, 1:1 aus VON-1803) und an einem strukturell
 * getippten `ObservationAuthorizer`. Dadurch ist die **Autorisierungs-Semantik** des Ports
 * — jede Read-Op läuft vor der Rückgabe durch `authorizeObservation()` — direkt mit `tsx`
 * testbar, ohne Miniflare/Workerd.
 *
 * Der `RpcTarget`-Shell (`RobomonHealthSession` in `gadget.ts`) delegiert 1:1 hierher; er
 * fügt nur die RPC-Fähigkeit und die Freigabe des Authorizers hinzu.
 */

import type {
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { RobomonSession, RunActivityView } from "./session.js";
import type { HealthSnapshot, TokenObservation, AuthmonAlarm } from "./health.js";

/**
 * Strukturelles Minimum eines `ObservationAuthorizer`. Der echte Overseer reicht einen
 * `RpcStub<ApprovalQueue>` herein; der Test reicht ein In-Memory-Objekt mit derselben
 * Methode. Beide erfüllen dieses Interface.
 */
export interface ObservationAuthorizerLike
  extends Pick<ObservationAuthorizer, "authorizeObservation"> {}

export type ActiveAlarmView = {
  persisted: AuthmonAlarm | null;
  derivedLevel: HealthSnapshot["level"];
  derivedKind: HealthSnapshot["kind"];
  detail: string;
  observedAt: string;
};

/**
 * Die vier read-only Observations des Bausteins, jede vor Rückgabe durch den Authorizer
 * geführt. Reihenfolge bewusst wie im MCP-Baustein (VON-1803): fetch → authorize → return.
 * Die Autorisierung passiert **nach** dem Lesen, damit die `ObservationDescription` die
 * tatsächlich beobachteten Kennzahlen benennen kann (analog `gatekeeper-context`); da die
 * Operation strikt lesend ist und nichts an den Aufrufer zurückgeht, bevor
 * `authorizeObservation()` aufgelöst hat, ist das für read-only zulässig.
 */
export class RobomonObservations {
  #session: RobomonSession;
  #authorizer: ObservationAuthorizerLike;

  constructor(session: RobomonSession, authorizer: ObservationAuthorizerLike) {
    this.#session = session;
    this.#authorizer = authorizer;
  }

  async #authorize(description: ObservationDescription): Promise<void> {
    await this.#authorizer.authorizeObservation(description);
  }

  /** Read: vollständige Auth-/Run-Health-Observation. */
  async getHealth(): Promise<HealthSnapshot> {
    const snap = await this.#session.getSnapshot();
    await this.#authorize({
      title: `Robomon-Health: ${snap.kind} (${snap.level})`,
      description:
        `Auth-/Run-Health-Snapshot aus der von-authmon-KV gelesen.\n\n` +
        `- Level: **${snap.level}** / Art: **${snap.kind}**\n` +
        `- Heartbeat-Alter: ${snap.heartbeatAgeMinutes ?? "–"} min (frisch: ${snap.heartbeatFresh})\n` +
        `- Host: ${snap.host ?? "?"}\n` +
        `- Detail: ${snap.detail}`,
    });
    return snap;
  }

  /** Read: kompakte Ampel-Zeile für Status-Dashboard-Gadgets. */
  async getHealthLine(): Promise<string> {
    const line = await this.#session.getHealthLine();
    await this.#authorize({
      title: "Robomon-Ampel gelesen",
      description: `Kompakte Health-Ampel: \`${line}\``,
    });
    return line;
  }

  /** Read: Run-Aktivität (Tageszähler + rollierendes Fenster + Fehlerquote). */
  async getRunActivity(): Promise<RunActivityView> {
    const activity = await this.#session.getRunActivity();
    const t = activity.today;
    await this.#authorize({
      title: "Robomon-Run-Aktivität gelesen",
      description:
        `Run-Kennzahlen der Agenten-Flotte gelesen.\n\n` +
        `- Heute: ${t ? `${t.succeeded ?? 0} ok / ${t.failed ?? 0} failed / ${t.total ?? 0} total` : "keine Daten"}\n` +
        `- Fenster-Fehlerquote: ${activity.windowFailRatePct ?? "–"}%\n` +
        `- Beobachtet: ${activity.observedAt}`,
    });
    return activity;
  }

  /** Read: OAuth-Token-Ablauf (rein informativ; kein Alarm). */
  async getTokenStatus(): Promise<TokenObservation | null> {
    const token = await this.#session.getTokenStatus();
    await this.#authorize({
      title: "Robomon-Token-Status gelesen",
      description: token
        ? `OAuth-Token läuft ${token.expired ? "ist abgelaufen" : `in ${token.expiresInHours} h ab`} (${token.expiresAt}). Rein informativ.`
        : "Kein Token-Ablaufdatum im aktuellen Heartbeat.",
    });
    return token;
  }

  /** Read: der aktuell offene von-authmon-Alarm plus frisch abgeleitete Bewertung (Triage). */
  async getActiveAlarm(): Promise<ActiveAlarmView> {
    const alarm = await this.#session.getActiveAlarm();
    await this.#authorize({
      title: `Robomon-Alarm-Triage: ${alarm.derivedKind} (${alarm.derivedLevel})`,
      description:
        `Aktiven von-authmon-Alarm für die Triage gelesen.\n\n` +
        `- Persistiert: ${alarm.persisted ? `${alarm.persisted.kind}/${alarm.persisted.level} seit ${new Date(alarm.persisted.since).toISOString()}` : "kein offener Alarm"}\n` +
        `- Frisch abgeleitet: ${alarm.derivedKind} / ${alarm.derivedLevel}\n` +
        `- Detail: ${alarm.detail}`,
    });
    return alarm;
  }
}
