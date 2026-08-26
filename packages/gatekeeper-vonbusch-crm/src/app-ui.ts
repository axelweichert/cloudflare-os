// vonBuschOS — CRM-Gatekeeper (K2, VON-1844): Board-UI / Approval-Queue-Panel.
//
// Macht den CRM-Gatekeeper in der ECHTEN CloudflareOS-Board-Oberfläche nicht nur *sichtbar*
// (als gebundener Vendor), sondern *nutzbar*: über `providesUi` + `startAppUi` (crm-gatekeeper.ts)
// erscheint das CRM als öffenbare App-Kachel; der Klick rendert diese Seite in einem sandboxed
// iframe. Rezept analog VON-1842 (K6 RoboMon, Branch von-1842-robomon-appui), hier für ein
// SCHREIB-Gadget: das Panel zeigt die offene Approval-Queue (create/update contact|deal|activity).
//
// Bewusst OHNE Browser-capnweb-Bundle für den Erst-Render: `startAppUi` liest die offenen
// Freigaben serverseitig aus dem CRM-Approval-Index (crm-gatekeeper.ts) und backt den Snapshot
// direkt ins iframe-HTML. Der Host (SandboxedGatekeeperApp) rendert das `srcDoc` unabhängig vom
// RPC-Handshake, daher genügt reines HTML/CSS (`default-src 'none'`, kein Skript) für einen
// robusten, headless verifizierbaren Klick-Nachweis. Die `ui`-Capability (CrmManagementApi) wird
// zusätzlich als RpcTarget mitgeliefert — für späteren Live-Refresh der Queue.

import { RpcTarget } from "capnweb";

/**
 * Eine offene (noch nicht angewandte) CRM-Schreibfreigabe, wie sie im Approval-Index steht.
 * Rein anzeigeorientiert; die maßgebliche Wirkung folgt erst durch den OS-Approve-Pfad
 * (ApprovalQueue → CrmGatekeeper.applyAction).
 */
export type PendingApprovalView = {
  /** Verbindungs-/Facet-Kennung (Account) — trennt Aktionen mehrerer Bindungen im Index. */
  connToken: string;
  /** Vom Gatekeeper vergebene Aktions-ID (facet-lokaler Zähler). */
  actionId: number;
  entity: "contact" | "deal" | "activity";
  op: "create" | "update";
  /** Ziel-Datensatz bei `update`. */
  targetId?: string;
  /** Menschlich lesbarer Titel (aus ActionDescription). */
  title: string;
  /** Ausführliche Beschreibung inkl. Feldliste (aus ActionDescription, Markdown-artig). */
  description: string;
  /** Wer die Aktion vorgeschlagen hat (Gadget-/Account-Kennung). */
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
 * Snapshot. Bewusst KEINE Approve/Reject-RPCs hier: die Freigabe-Autorität bleibt allein beim
 * OS-Approve-Pfad (menschliche ApprovalQueue → applyAction), damit das Panel den Sicherheits-
 * kontrakt (kein ungeprüfter Schreibzugriff) nicht umgeht.
 */
export class CrmManagementApi extends RpcTarget {
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

const ENTITY_LABEL: Record<PendingApprovalView["entity"], string> = {
  contact: "Kontakt",
  deal: "Deal",
  activity: "Aktivität",
};

/**
 * Baut aus der Freigabe-Beschreibung (Markdown-artige `- **feld:** wert`-Zeilen) eine kompakte,
 * sichere HTML-Feldliste. Keine echte Markdown-Engine — nur die vom Session-Kern erzeugten
 * Bullet-Zeilen werden erkannt; alles andere wird escaped als Absatz gezeigt.
 */
function renderDescription(description: string): string {
  const lines = String(description ?? "").split("\n");
  const bullets: string[] = [];
  const paras: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (m) {
      bullets.push(`<li><span class="k">${esc(m[1])}</span><span class="v">${esc(m[2]) || "∅"}</span></li>`);
    } else {
      // **fett** am Zeilenanfang (z.B. "**Begründung:** …") knapp hervorheben, sonst Klartext.
      const b = /^\*\*(.+?):\*\*\s*(.*)$/.exec(line);
      if (b) paras.push(`<p><strong>${esc(b[1])}:</strong> ${esc(b[2])}</p>`);
      else paras.push(`<p>${esc(line)}</p>`);
    }
  }
  return (bullets.length ? `<ul>${bullets.join("")}</ul>` : "") + paras.join("");
}

function fmtWhen(ms: number): string {
  if (!ms || !isFinite(ms)) return "—";
  // Deterministisch, ohne Locale-Abhängigkeit: ISO bis auf Minute.
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Baut die vollständige, in sich geschlossene iframe-Seite aus der offenen Approval-Queue.
 * `observedAt` ist ein ISO-Zeitstempel des Snapshots.
 */
export function buildCrmAppHtml(pending: PendingApprovalView[], observedAt: string): string {
  const count = pending.length;
  const accent = count > 0 ? "#b7791f" : "#2f855a";
  const bg = count > 0 ? "#fffaf0" : "#f0fff4";
  const banner =
    count > 0
      ? `${count} offene Freigabe${count === 1 ? "" : "n"} — warten auf menschliche Bestätigung`
      : "Keine offenen Freigaben — die Schreib-Queue ist leer";

  const cards = pending
    .map((p) => {
      const label = ENTITY_LABEL[p.entity] ?? esc(p.entity);
      const verb = p.op === "create" ? "anlegen" : "ändern";
      const target = p.targetId ? ` <code>#${esc(p.targetId)}</code>` : "";
      return `<article class="card">
  <header>
    <span class="badge badge-${esc(p.op)}">${esc(verb)}</span>
    <h2>${esc(label)}${target}</h2>
    <span class="aid">#${esc(p.actionId)}</span>
  </header>
  <p class="title">${esc(p.title)}</p>
  <div class="body">${renderDescription(p.description)}</div>
  <footer>
    <span>Vorgeschlagen von <code>${esc(p.proposedBy)}</code></span>
    <span>${esc(fmtWhen(p.proposedAt))}</span>
  </footer>
</article>`;
    })
    .join("\n");

  const empty = `<div class="empty">
    <p>Vorgeschlagene Schreibaktionen (Kontakt/Deal/Aktivität) erscheinen hier, sobald ein Agent
    <code>proposeContact</code>/<code>proposeDeal</code>/<code>proposeActivity</code> aufruft.</p>
    <p>Freigeben oder Ablehnen erfolgt über die OS-Freigabe-Ansicht (ApprovalQueue) — dieses Panel
    zeigt den Live-Stand der Queue.</p>
  </div>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>vonBusch CRM — Freigaben</title>
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
  .card header h2 { font-size: 15px; margin: 0; flex: 1; }
  .aid { color: #a0aec0; font-size: 12px; }
  .badge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
  .badge-create { background: #c6f6d5; color: #22543d; }
  .badge-update { background: #feebc8; color: #7b341e; }
  .title { font-weight: 600; margin: 0 0 8px; }
  .body ul { list-style: none; margin: 0 0 8px; padding: 0; }
  .body li { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #f7fafc; }
  .body .k { color: #4a5568; font-weight: 600; min-width: 120px; }
  .body .v { color: #1a202c; word-break: break-word; }
  .body p { margin: 6px 0; color: #4a5568; }
  .card footer { display: flex; justify-content: space-between; gap: 12px; color: #a0aec0; font-size: 11px; margin-top: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .empty { color: #718096; max-width: 620px; }
  footer.page { margin-top: 22px; color: #a0aec0; font-size: 11px; }
</style>
</head>
<body>
  <h1>vonBusch CRM — Freigaben</h1>
  <p class="sub">Human-in-the-Loop · Kontakte / Deals / Aktivitäten (vonbusch-crm-eu) · Stand ${esc(observedAt)}</p>
  <div class="banner">
    <span class="dot"></span>
    <strong>${esc(banner)}</strong>
  </div>
  ${count > 0 ? cards : empty}
  <footer class="page">CloudflareOS-Gatekeeper · gatekeeper-vonbusch-crm (K2, VON-1817/VON-1844) · Reads direkt, Writes nur nach Freigabe</footer>
</body>
</html>`;
}
