// vonBuschOS — JustIn-ERP-Gatekeeper: Freigabe-UI (VON-1804 / K3)
//
// Serverseitig gerendertes HTML (kein Build, keine Client-Deps). Zeigt offene Angebots-
// Vorschläge und erlaubt Freigabe/Ablehnung via fetch() an die /api/queue-Routen. Bei
// approve ruft der Worker `adapter.createQuote` gegen das reale JustIn-ERP auf.

import type { QuoteQueueItem } from "./quote-queue.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    pending: "#d97706",
    approved: "#2563eb",
    applied: "#16a34a",
    rejected: "#6b7280",
    failed: "#dc2626",
  };
  return `<span style="background:${colors[status] ?? "#6b7280"};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${esc(status)}</span>`;
}

function renderLines(item: QuoteQueueItem): string {
  const rows = item.action.lines
    .map(
      (l) =>
        `<tr><td class="v">${esc(l.sku)}</td><td class="v">${esc(String(l.qty))}</td><td class="v">${
          l.unitPrice !== undefined ? esc(String(l.unitPrice)) : "—"
        }</td></tr>`,
    )
    .join("");
  return `<table class="fields"><thead><tr><th>SKU</th><th>Menge</th><th>Stückpreis</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderItem(item: QuoteQueueItem): string {
  const a = item.action;
  const pending = item.status === "pending";
  const actions = pending
    ? `<div class="actions">
         <button onclick="decide('${esc(item.id)}','approve')" class="approve">Freigeben &amp; Angebot anlegen</button>
         <button onclick="decide('${esc(item.id)}','reject')" class="reject">Ablehnen</button>
       </div>`
    : `<div class="meta">${item.decidedBy ? `entschieden von ${esc(item.decidedBy)}` : ""}${
        item.resultNumber ? ` · Angebot ${esc(item.resultNumber)}` : item.resultId ? ` · ${esc(item.resultId)}` : ""
      }${item.error ? ` · Fehler: ${esc(item.error)}` : ""}</div>`;

  return `<div class="card">
    <div class="head">${statusBadge(item.status)} <span class="op">Angebot · Kunde ${esc(a.customerId)}</span></div>
    ${renderLines(item)}
    <div class="meta">Von ${esc(a.proposedBy)}${a.note ? ` · Notiz: ${esc(a.note)}` : ""}${
      a.validUntil ? ` · gültig bis ${esc(a.validUntil)}` : ""
    }${a.reason ? ` · Grund: ${esc(a.reason)}` : ""}</div>
    ${actions}
  </div>`;
}

export function renderQueuePage(items: QuoteQueueItem[]): string {
  const pending = items.filter((i) => i.status === "pending");
  const others = items.filter((i) => i.status !== "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ERP-Angebotsfreigabe · vonBuschOS</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 820px; margin: 0 auto; padding: 24px; background: #f5f5f5; color: #1a1a1a; }
  h1 { font-size: 22px; } h2 { font-size: 16px; color: #555; margin-top: 32px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .head { display: flex; align-items: center; gap: 8px; }
  .op { color: #333; font-size: 14px; font-weight: 600; }
  .fields { border-collapse: collapse; margin: 10px 0; width: 100%; font-size: 13px; }
  .fields th, .fields td { border: 1px solid #eee; padding: 5px 8px; vertical-align: top; text-align: left; }
  .fields th { color: #666; background: #fafafa; }
  .meta { color: #888; font-size: 12px; margin-top: 6px; }
  .actions { margin-top: 12px; display: flex; gap: 8px; }
  button { padding: 8px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .approve { background: #16a34a; color: #fff; } .reject { background: #e5e7eb; color: #333; }
  .empty { color: #999; padding: 24px; text-align: center; }
</style>
</head>
<body>
  <h1>🧾 ERP-Angebotsfreigabe</h1>
  <p class="meta">Von Agenten vorgeschlagene Angebote (JustIn ERP). Freigabe legt das Angebot real im ERP an. Lesen (Rechnungen/Aufträge/Bestände/Status) läuft ohne Freigabe.</p>
  <h2>Offen (${pending.length})</h2>
  ${pending.length ? pending.map(renderItem).join("") : '<div class="empty">Keine offenen Vorschläge.</div>'}
  <h2>Erledigt</h2>
  ${others.length ? others.slice(0, 50).map(renderItem).join("") : '<div class="empty">—</div>'}
<script>
async function decide(id, action) {
  const note = action === 'reject' ? prompt('Notiz (optional):') || undefined : undefined;
  const res = await fetch('/api/queue/' + encodeURIComponent(id) + '/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) { alert('Fehler: ' + (data.message || res.status)); return; }
  location.reload();
}
</script>
</body>
</html>`;
}
