/**
 * Robomon Management-UI (VON-1842).
 *
 * Macht den read-only Gatekeeper in der ECHTEN CloudflareOS-Board-Oberflaeche nicht nur
 * *sichtbar* (als gebundener Vendor), sondern *nutzbar*: ueber `providesUi` + `startAppUi`
 * erscheint Robomon als oeffenbare App-Kachel unter `/gatekeepers/<id>`; der Klick darauf
 * rendert diese Seite in einem sandboxed iframe.
 *
 * Bewusst OHNE Browser-capnweb-Bundle: `startAppUi` liest die von-authmon-KV serverseitig und
 * backt den Snapshot direkt in das iframe-HTML. Der Host (SandboxedGatekeeperApp) rendert das
 * `srcDoc` unabhaengig vom RPC-Handshake, daher genuegt reines HTML/CSS (`connect-src 'none'`,
 * kein Skript) fuer einen robusten, headless verifizierbaren Klick-Nachweis. Die `ui`-Capability
 * (RobomonManagementApi) wird zusaetzlich mitgeliefert fuer spaeteren Live-Refresh.
 *
 * Read-only: keine Actions, keine Schreibzugriffe (Quelle bleibt von-authmon, VON-1689).
 */

import { RpcTarget } from "capnweb";
import { RobomonSession, type RunActivityView } from "./session.js";
import { healthLine, type HealthSnapshot, type TokenObservation } from "./health.js";

/**
 * `ui`-Capability des App-Frames: read-only Delegation an RobomonSession. Der iframe kann sie
 * (nach Handshake) fuer Live-Refresh nutzen; der Erst-Render kommt aus dem gebackenen Snapshot.
 */
export class RobomonManagementApi extends RpcTarget {
  #session: RobomonSession;

  constructor(session: RobomonSession) {
    super();
    this.#session = session;
  }

  getSnapshot(): Promise<HealthSnapshot> {
    return this.#session.getSnapshot();
  }
  getHealthLine(): Promise<string> {
    return this.#session.getHealthLine();
  }
  getRunActivity(): Promise<RunActivityView> {
    return this.#session.getRunActivity();
  }
  getTokenStatus(): Promise<TokenObservation | null> {
    return this.#session.getTokenStatus();
  }
}

/** Minimales HTML-Escaping fuer in Text-/Attributkontext gebackene Werte. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtAge(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Baut die vollstaendige, in sich geschlossene iframe-Seite aus einem Health-Snapshot. */
export function buildRobomonAppHtml(
  snapshot: HealthSnapshot,
  activity: RunActivityView,
): string {
  const line = healthLine(snapshot);
  const ok = snapshot.level === "OK";
  const accent = ok ? "#2f855a" : "#c53030";
  const bg = ok ? "#f0fff4" : "#fff5f5";
  const today = snapshot.runToday;
  const win = snapshot.runWindow;
  const token = snapshot.token;

  const rows: Array<[string, string]> = [
    ["Zustand", `${esc(snapshot.level)} · ${esc(snapshot.kind)}`],
    ["Detail", esc(snapshot.detail)],
    ["Heartbeat-Alter", `${fmtAge(snapshot.heartbeatAgeMinutes)}${snapshot.heartbeatFresh ? " (frisch)" : ""}`],
    ["Host", esc(snapshot.host ?? "—")],
    [
      "Runs heute",
      today
        ? `${esc(today.succeeded ?? 0)} ok / ${esc(today.failed ?? 0)} fehlgeschlagen / ${esc(today.total ?? 0)} gesamt`
        : "—",
    ],
    [
      "Fenster (rollierend)",
      win
        ? `${esc(win.succeeded ?? 0)} ok / ${esc(win.failed ?? 0)} fehlgeschlagen · Fehlerquote ${activity.windowFailRatePct == null ? "—" : esc(activity.windowFailRatePct) + " %"}`
        : "—",
    ],
    [
      "OAuth-Token",
      token
        ? `${token.expired ? "ABGELAUFEN" : "gueltig"} · ${esc(Math.round(token.expiresInHours))} h · ${esc(token.expiresAt)}`
        : "—",
    ],
    [
      "von-authmon-Alarm",
      snapshot.authmonAlarm
        ? `${esc(snapshot.authmonAlarm.kind)} (${esc(snapshot.authmonAlarm.level)})`
        : "kein offener Alarm",
    ],
  ];

  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>Robomon</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a202c; background: #fff;
  }
  .banner {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px; border-radius: 10px;
    background: ${bg}; border: 1px solid ${accent}33; margin-bottom: 20px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${accent}; flex: none; }
  .banner strong { color: ${accent}; font-size: 15px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #718096; font-size: 12px; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #edf2f7; vertical-align: top; }
  th[scope="row"] { color: #4a5568; font-weight: 600; white-space: nowrap; width: 190px; }
  td { color: #1a202c; }
  footer { margin-top: 22px; color: #a0aec0; font-size: 11px; }
</style>
</head>
<body>
  <h1>Robomon — Auth- &amp; Run-Health der Agenten-Flotte</h1>
  <p class="sub">Read-only · Quelle: von-authmon (VON-1689) · Stand ${esc(snapshot.observedAt)}</p>
  <div class="banner">
    <span class="dot"></span>
    <strong>${esc(line)}</strong>
  </div>
  <table>
    <tbody>${tableRows}</tbody>
  </table>
  <footer>CloudflareOS-Gatekeeper · gatekeeper-vonbusch-robomon (K6, VON-1814/VON-1842)</footer>
</body>
</html>`;
}
