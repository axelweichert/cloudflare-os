/**
 * Robomon-Session — die Tool-Oberfläche des read-only Monitoring-Bausteins
 * (VON-1803 / K6).
 *
 * Runtime-agnostisch: hängt nur an einer read-only `HealthRepo`-Abstraktion, nicht
 * an KV/Workers direkt → in Tests mit In-Memory-Repo, im Worker mit KV-Repo.
 *
 * Alle Methoden sind READS (Observations). Es gibt keine Actions — der Gatekeeper
 * schreibt nie und alarmiert nie (das macht weiterhin von-authmon, VON-1689). Er
 * macht dessen Zustand nur für Status-Dashboard-Gadgets und Alarm-Triage-Agenten
 * konsumierbar (Strategy D, low-stakes).
 */

import {
  deriveHealth,
  healthLine,
  type AuthmonAlarm,
  type AuthmonState,
  type HealthSnapshot,
  type RunToday,
  type RunWindow,
  type TokenObservation,
} from "./health.ts";

/** Nur-Lese-Zugriff auf die von-authmon-KV. Der Worker liefert die KV-Implementierung. */
export interface HealthRepo {
  /** Aktueller KV-Zustand (bootAt, hb, alarm). */
  ladeState(): Promise<AuthmonState>;
}

/** Für Dashboards/Agenten aufbereitete Run-Kennzahlen. */
export interface RunActivityView {
  today: RunToday | null;
  window: RunWindow | null;
  /** Fehlerquote im rollierenden Fenster [%], null ohne Baseline. */
  windowFailRatePct: number | null;
  observedAt: string;
}

export class RobomonSession {
  #repo: HealthRepo;
  #now: () => number;

  constructor(repo: HealthRepo, now: () => number = () => Date.now()) {
    this.#repo = repo;
    this.#now = now;
  }

  /** Read: vollständige Health-/Auth-Observation (die zentrale Beobachtung). */
  async getSnapshot(): Promise<HealthSnapshot> {
    const state = await this.#repo.ladeState();
    return deriveHealth(this.#now(), state);
  }

  /** Read: kompakte Ampel-Zeile für Status-Dashboard-Gadgets. */
  async getHealthLine(): Promise<string> {
    return healthLine(await this.getSnapshot());
  }

  /** Read: Run-Aktivität (Tageszähler + rollierendes Fenster + Fehlerquote). */
  async getRunActivity(): Promise<RunActivityView> {
    const snap = await this.getSnapshot();
    const w = snap.runWindow;
    let windowFailRatePct: number | null = null;
    if (w && Number(w.total) > 0) {
      windowFailRatePct = Math.round((Number(w.failed || 0) * 100) / Number(w.total));
    }
    return {
      today: snap.runToday,
      window: w,
      windowFailRatePct,
      observedAt: snap.observedAt,
    };
  }

  /** Read: OAuth-Token-Ablauf (rein informativ; kein Alarm — vgl. VON-1775). */
  async getTokenStatus(): Promise<TokenObservation | null> {
    return (await this.getSnapshot()).token;
  }

  /**
   * Read: der aktuell offene von-authmon-Alarm für Triage-Agenten. Kombiniert den
   * persistierten Alarm mit der frisch abgeleiteten Bewertung — praktisch für
   * einen Agenten, der entscheidet, ob eine Bedingung noch aktiv ist.
   */
  async getActiveAlarm(): Promise<{
    persisted: AuthmonAlarm | null;
    derivedLevel: HealthSnapshot["level"];
    derivedKind: HealthSnapshot["kind"];
    detail: string;
    observedAt: string;
  }> {
    const snap = await this.getSnapshot();
    return {
      persisted: snap.authmonAlarm,
      derivedLevel: snap.level,
      derivedKind: snap.kind,
      detail: snap.detail,
      observedAt: snap.observedAt,
    };
  }
}
