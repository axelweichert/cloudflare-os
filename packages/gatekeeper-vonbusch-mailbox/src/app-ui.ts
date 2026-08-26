/**
 * vonBusch-Mailbox — Management-UI (VON-1845).
 *
 * Macht den Mailbox-Gatekeeper (K1) in der ECHTEN CloudflareOS-Board-Oberflaeche nicht nur
 * *sichtbar* (als gebundener Vendor, VON-1822), sondern *nutzbar*: ueber `providesUi` +
 * `startAppUi` (am Account) erscheint die Mailbox als oeffenbare App-Kachel unter
 * `/gatekeepers/<id>`; der Klick darauf rendert diese Seite in einem sandboxed iframe.
 *
 * Dies ist ein WRITE-Gadget (ausgehende Mail laeuft ueber Human-in-the-Loop-Approval). Die
 * Management-UI backt daher serverseitig die *Sicherheits- und Freigabe-Haltung* in das iframe-HTML:
 * die per-Mailbox-ACL-Zusammenfassung (VON-1798), den Backend-Modus und das Approval-Modell
 * (Reads = auditierte Observations, Sends/Replies = eingereihte Freigaben). Kein Browser-capnweb
 * noetig — der Host (SandboxedGatekeeperApp) rendert das `srcDoc` unabhaengig vom RPC-Handshake, daher
 * genuegt reines, netzisoliertes HTML/CSS (`default-src 'none'`, kein Skript) fuer einen robusten,
 * headless verifizierbaren Klick-Nachweis. Die `ui`-Capability (MailboxManagementApi) wird
 * zusaetzlich mitgeliefert fuer spaeteren Live-Refresh.
 *
 * Bewusste Grenze: die offenen Freigaben leben je gebundener Mailbox im `MailboxGatekeeper`-DO und
 * werden im nativen Approval-Posteingang des Boards entschieden (der `submitAction()`-Zielort). Die
 * Account-Kachel enumeriert sie nicht cross-DO (dafuer braeuchte es ein Account-Register); sie zeigt
 * das Freigabe-Modell und verweist auf den Board-Posteingang. Read-only, keine Schreibzugriffe.
 */

import { RpcTarget } from "capnweb";
import { parseAcl } from "./mailbox-authz";

export type MailboxBackendMode = "service-binding" | "token" | "none";

/** Serverseitig abgeleitete, nicht-vertrauliche Sicht auf die Gatekeeper-Konfiguration. */
export type MailboxAppView = {
  /** Ob der Betrachter Board-Admin ist (frisch pro Oeffnung uebergeben, AppUiContext.isAdmin). */
  isAdmin: boolean;
  /** In der ACL konfigurierte Mailbox-IDs (nur IDs, keine Identitaeten/E-Mails). */
  configuredMailboxes: string[];
  /** Anzahl globaler Admins in der ACL (ohne Klartext-Identitaeten). */
  adminCount: number;
  /** Wie der Upstream (agentic-inbox) erreicht wird. */
  backendMode: MailboxBackendMode;
  /** Ziel-URL des Upstream-/mcp (nur Host/Pfad, kein Secret). */
  upstreamUrl: string;
};

/**
 * Leitet die Sicht rein aus Primitiven ab (kein Env-Zugriff) — damit tsx/node-testbar. Zeigt
 * bewusst nur Metadaten (IDs, Zaehler, Modus), nie ACL-Identitaeten oder Tokens.
 */
export function buildMailboxAppView(input: {
  aclRaw: string | undefined;
  isAdmin: boolean;
  hasService: boolean;
  hasToken: boolean;
  upstreamUrl: string | undefined;
}): MailboxAppView {
  const acl = parseAcl(input.aclRaw);
  const backendMode: MailboxBackendMode = input.hasService
    ? "service-binding"
    : input.hasToken
      ? "token"
      : "none";
  return {
    isAdmin: input.isAdmin,
    configuredMailboxes: Object.keys(acl.mailboxes),
    adminCount: (acl.admins ?? []).length,
    backendMode,
    upstreamUrl: input.upstreamUrl ?? "—",
  };
}

/**
 * `ui`-Capability des App-Frames: read-only Delegation an die abgeleitete Sicht. Der iframe kann sie
 * (nach Handshake) fuer Live-Refresh nutzen; der Erst-Render kommt aus dem gebackenen Snapshot.
 * Bewusst KEINE mutierenden Methoden — Sends/Replies laufen ausschliesslich ueber die
 * Approval-Queue der gebundenen Mailbox, nie ueber diese Management-Kapsel.
 */
export class MailboxManagementApi extends RpcTarget {
  #view: MailboxAppView;

  constructor(view: MailboxAppView) {
    super();
    this.#view = view;
  }

  getView(): Promise<MailboxAppView> {
    return Promise.resolve(this.#view);
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

const BACKEND_LABEL: Record<MailboxBackendMode, string> = {
  "service-binding": "Service-Binding → agentic-inbox (intern, kein Bearer, umgeht CF Access)",
  token: "HTTP + Bearer-Token (Fallback)",
  none: "nicht konfiguriert",
};

/** Baut die vollstaendige, in sich geschlossene iframe-Seite aus der abgeleiteten Sicht. */
export function buildMailboxAppHtml(view: MailboxAppView): string {
  const configured = view.configuredMailboxes.length;
  const ok = view.backendMode !== "none";
  const accent = ok ? "#2f6db4" : "#c53030";
  const bg = ok ? "#eff6fc" : "#fff5f5";
  const banner = ok
    ? `Mailbox-Gatekeeper aktiv · ${configured} Mailbox${configured === 1 ? "" : "en"} konfiguriert`
    : "Upstream nicht konfiguriert — Deploy-Gate offen";

  const mailboxList =
    configured === 0
      ? `<li class="muted">Keine Mailbox gepinnt (ACL leer — nur Admins, CEO-Deploy-Gate)</li>`
      : view.configuredMailboxes.map(m => `<li><code>${esc(m)}</code></li>`).join("");

  const postureRows: Array<[string, string]> = [
    ["Betrachter", view.isAdmin ? "Board-Admin" : "Standard-Nutzer"],
    ["Backend-Modus", esc(BACKEND_LABEL[view.backendMode])],
    ["Upstream", `<code>${esc(view.upstreamUrl)}</code>`],
    ["Konfigurierte Mailboxen", String(configured)],
    ["Globale Admins (ACL)", String(view.adminCount)],
    [
      "Per-Mailbox-Autorisierung",
      "fail-closed · <code>addObserver()</code> prueft ACL erneut (VON-1798)",
    ],
    ["Sichtbarkeit", "unberechtigte Nutzer sehen den Gatekeeper nicht (leere Ressourcenliste)"],
  ];

  const tableRows = postureRows
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>vonBusch Mailbox</title>
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
  h2 { font-size: 14px; margin: 22px 0 8px; color: #2d3748; }
  .sub { color: #718096; font-size: 12px; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 760px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #edf2f7; vertical-align: top; }
  th[scope="row"] { color: #4a5568; font-weight: 600; white-space: nowrap; width: 210px; }
  td { color: #1a202c; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f7fafc; padding: 1px 5px; border-radius: 4px; }
  ul { margin: 8px 0; padding-left: 20px; }
  li { margin: 2px 0; }
  .muted { color: #a0aec0; list-style: none; margin-left: -20px; }
  .flow { max-width: 760px; margin: 8px 0 0; padding: 12px 16px; background: #f7fafc; border-radius: 8px; }
  .flow p { margin: 4px 0; }
  .tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; margin-right: 6px; }
  .tag.read { background: #e6fffa; color: #234e52; }
  .tag.write { background: #fffaf0; color: #7b341e; }
  footer { margin-top: 22px; color: #a0aec0; font-size: 11px; }
</style>
</head>
<body>
  <h1>vonBusch Mailbox — gepinnte agentic-inbox-Mailbox</h1>
  <p class="sub">Human-in-the-Loop · per-Mailbox-Autorisierung (VON-1798) · Quelle: mail.vonbusch.app</p>
  <div class="banner">
    <span class="dot"></span>
    <strong>${esc(banner)}</strong>
  </div>

  <h2>Sicherheits- &amp; Konfigurations-Haltung</h2>
  <table><tbody>${tableRows}</tbody></table>

  <h2>Konfigurierte Mailboxen</h2>
  <ul>${mailboxList}</ul>

  <h2>Freigabe-Modell</h2>
  <div class="flow">
    <p><span class="tag read">READ</span>Threads/Nachrichten lesen — laufen sofort, jede als auditierte Observation (<code>authorizeObservation()</code>).</p>
    <p><span class="tag write">WRITE</span>Senden/Antworten — werden zur Human-in-the-Loop-Freigabe eingereiht (<code>submitAction()</code>); die Wirkung tritt erst nach Approval ein (<code>applyAction()</code>). Nie auto-approvable.</p>
    <p class="sub" style="margin-top:8px">Offene Freigaben werden im Approval-Posteingang des Boards entschieden.</p>
  </div>

  <footer>CloudflareOS-Gatekeeper · gatekeeper-vonbusch-mailbox (K1, VON-1815/VON-1845)</footer>
</body>
</html>`;
}
