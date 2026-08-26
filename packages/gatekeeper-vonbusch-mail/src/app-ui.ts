// vonBuschOS — Mail-Gatekeeper (K5, VON-1847): Board-UI / Approval-Queue-Panel.
//
// Macht den Mail-Gatekeeper in der ECHTEN CloudflareOS-Board-Oberfläche nicht nur *sichtbar*
// (als gebundener Vendor), sondern *nutzbar*: über `providesUi` + `startAppUi` (mail-gatekeeper.ts)
// erscheint der Mailer als öffenbare App-Kachel; der Klick rendert diese Seite in einem sandboxed
// iframe. Rezept analog VON-1842 (K6 RoboMon) / VON-1844 (K2 CRM), hier für ein SCHREIB-Gadget:
// das Panel zeigt die offene Sende-Approval-Queue (proposeEmail → CF send_email).
//
// Bewusst OHNE Browser-capnweb-Bundle für den Erst-Render: `startAppUi` liest die offenen
// Freigaben serverseitig aus dem Mail-Approval-Index (mail-gatekeeper.ts) und backt den Snapshot
// direkt ins iframe-HTML. Der Host (SandboxedGatekeeperApp) rendert das `srcDoc` unabhängig vom
// RPC-Handshake, daher genügt reines HTML/CSS (`default-src 'none'`, kein Skript) für einen
// robusten, headless verifizierbaren Klick-Nachweis. Die `ui`-Capability (MailManagementApi) wird
// zusätzlich als RpcTarget mitgeliefert — für späteren Live-Refresh der Queue.

import { RpcTarget } from "capnweb";

/**
 * Eine offene (noch nicht versendete) Mail-Sendefreigabe, wie sie im Approval-Index steht.
 * Rein anzeigeorientiert; der maßgebliche Versand folgt erst durch den OS-Approve-Pfad
 * (ApprovalQueue → MailGatekeeper.applyAction → env.EMAIL.send).
 */
export type PendingApprovalView = {
  /** Verbindungs-/Facet-Kennung (Account) — trennt Aktionen mehrerer Bindungen im Index. */
  connToken: string;
  /** Vom Gatekeeper vergebene Aktions-ID (facet-lokaler Zähler). */
  actionId: number;
  /** Empfängeradresse. */
  to: string;
  /** Absenderadresse (aus Allowlist; Standard noreply@vonbusch.app). */
  from: string;
  /** Betreff. */
  subject: string;
  /** Klartext-Body (wird im Panel gekürzt vorschau-gerendert). */
  text: string;
  /** Optionale Begründung des Vorschlags (für den freigebenden Menschen). */
  reason?: string;
  /** Wer die Mail vorgeschlagen hat (Gadget-/Account-Kennung). */
  proposedBy: string;
  /** Einreih-Zeitpunkt (epoch ms). */
  proposedAt: number;
};

/** Was das Panel/die ui-Capability zum Rendern der offenen Freigaben braucht. */
export interface PendingApprovalSource {
  listPendingApprovals(): Promise<PendingApprovalView[]>;
}

/**
 * `ui`-Capability des App-Frames: read-only Delegation an den Approval-Index. Der iframe kann sie
 * (nach Handshake) für Live-Refresh der Queue nutzen; der Erst-Render kommt aus dem gebackenen
 * Snapshot. Bewusst KEINE Approve/Reject-RPCs hier: die Sendegewalt bleibt allein beim OS-Approve-
 * Pfad (menschliche ApprovalQueue → applyAction → env.EMAIL.send), damit das Panel den Sicherheits-
 * kontrakt (kein ungeprüfter Versand) nicht umgeht.
 */
export class MailManagementApi extends RpcTarget {
  #source: PendingApprovalSource;

  constructor(source: PendingApprovalSource) {
    super();
    this.#source = source;
  }

  listPendingApprovals(): Promise<PendingApprovalView[]> {
    return this.#source.listPendingApprovals();
  }
}

/** Minimales HTML-Escaping für in Text-/Attributkontext gebackene Werte. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Kürzt eine Body-Vorschau auf max. `n` Zeichen (an Wortgrenze, mit Ellipsis). */
export function preview(text: string, n = 240): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

function fmtWhen(ms: number): string {
  if (!ms || !isFinite(ms)) return "—";
  // Deterministisch, ohne Locale-Abhängigkeit: ISO bis auf Minute.
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Baut die vollständige, in sich geschlossene iframe-Seite aus der offenen Sende-Approval-Queue.
 * `observedAt` ist ein ISO-Zeitstempel des Snapshots.
 */
export function buildMailAppHtml(pending: PendingApprovalView[], observedAt: string): string {
  const count = pending.length;
  const accent = count > 0 ? "#b7791f" : "#2f855a";
  const bg = count > 0 ? "#fffaf0" : "#f0fff4";
  const banner =
    count > 0
      ? `${count} offene Sende-Freigabe${count === 1 ? "" : "n"} — warten auf menschliche Bestätigung`
      : "Keine offenen Sende-Freigaben — die Mail-Queue ist leer";

  const cards = pending
    .map((p) => {
      const body = preview(p.text);
      const reason = p.reason
        ? `<div class="body"><ul><li><span class="k">Begründung</span><span class="v">${esc(p.reason)}</span></li></ul></div>`
        : "";
      return `<article class="card">
  <header>
    <span class="badge">senden</span>
    <h2>${esc(p.subject) || "(kein Betreff)"}</h2>
    <span class="aid">#${esc(p.actionId)}</span>
  </header>
  <div class="body">
    <ul>
      <li><span class="k">An</span><span class="v"><code>${esc(p.to)}</code></span></li>
      <li><span class="k">Von</span><span class="v"><code>${esc(p.from)}</code></span></li>
    </ul>
  </div>
  <p class="preview">${esc(body) || "∅"}</p>
  ${reason}
  <footer>
    <span>Vorgeschlagen von <code>${esc(p.proposedBy)}</code></span>
    <span>${esc(fmtWhen(p.proposedAt))}</span>
  </footer>
</article>`;
    })
    .join("\n");

  const empty = `<div class="empty">
    <p>Vorgeschlagene ausgehende E-Mails erscheinen hier, sobald ein Agent <code>proposeEmail</code>
    aufruft.</p>
    <p>Freigeben oder Ablehnen erfolgt über die OS-Freigabe-Ansicht (ApprovalQueue) — dieses Panel
    zeigt den Live-Stand der Queue. Erst nach Freigabe versendet der Mailer über CF send_email.</p>
  </div>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>vonBusch Mail — Freigaben</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a202c; background: #fff;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #718096; font-size: 12px; margin: 0 0 20px; }
  .banner {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px; border-radius: 10px;
    background: ${bg}; border: 1px solid ${accent}33; margin-bottom: 20px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${accent}; flex: none; }
  .banner strong { color: ${accent}; font-size: 15px; }
  .card {
    border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px;
  }
  .card header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .card header h2 { font-size: 15px; margin: 0; flex: 1; word-break: break-word; }
  .aid { color: #a0aec0; font-size: 12px; }
  .badge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; background: #feebc8; color: #7b341e; }
  .body ul { list-style: none; margin: 0 0 8px; padding: 0; }
  .body li { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #f7fafc; }
  .body .k { color: #4a5568; font-weight: 600; min-width: 90px; }
  .body .v { color: #1a202c; word-break: break-word; }
  .preview { margin: 6px 0 8px; color: #4a5568; white-space: pre-wrap; word-break: break-word; }
  .card footer { display: flex; justify-content: space-between; gap: 12px; color: #a0aec0; font-size: 11px; margin-top: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .empty { color: #718096; max-width: 620px; }
  footer.page { margin-top: 22px; color: #a0aec0; font-size: 11px; }
</style>
</head>
<body>
  <h1>vonBusch Mail — Freigaben</h1>
  <p class="sub">Human-in-the-Loop · Ausgehende E-Mails (CF send_email, noreply@vonbusch.app) · Stand ${esc(observedAt)}</p>
  <div class="banner">
    <span class="dot"></span>
    <strong>${esc(banner)}</strong>
  </div>
  ${count > 0 ? cards : empty}
  <footer class="page">CloudflareOS-Gatekeeper · gatekeeper-vonbusch-mail (K5, VON-1818/VON-1847) · Versand nur nach Freigabe</footer>
</body>
</html>`;
}
