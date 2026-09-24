// vonBuschOS — Mail-Gatekeeper: Freigabe-UI (VON-1802 / K5)
//
// Serverseitig gerenderte HTML-Seite (kein Build-Schritt, keine Client-Dependencies).
// Zeigt offene Vorschläge und erlaubt Freigabe/Ablehnung via fetch() an die /api/queue-Routen.

import type { QueueItem } from "./approval-queue.ts";

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
    sent: "#16a34a",
    rejected: "#6b7280",
    failed: "#dc2626",
  };
  return `<span style="background:${colors[status] ?? "#6b7280"};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${esc(status)}</span>`;
}

function renderItem(item: QueueItem): string {
  const p = item.proposal;
  const pending = item.status === "pending";
  const actions = pending
    ? `<div class="actions">
         <button onclick="decide('${esc(item.id)}','approve')" class="approve">Freigeben &amp; Senden</button>
         <button onclick="decide('${esc(item.id)}','reject')" class="reject">Ablehnen</button>
       </div>`
    : `<div class="meta">${item.decidedBy ? `entschieden von ${esc(item.decidedBy)}` : ""}${item.sentMessageId ? ` · id ${esc(item.sentMessageId)}` : ""}${item.error ? ` · Fehler: ${esc(item.error)}` : ""}</div>`;

  return `<div class="card">
    <div class="head">${statusBadge(item.status)} <span class="from">${esc(p.from)} → ${esc(p.to)}</span></div>
    <div class="subject">${esc(p.subject)}</div>
    <pre class="body">${esc(p.text)}</pre>
    <div class="meta">Von ${esc(p.proposedBy)}${p.reason ? ` · Grund: ${esc(p.reason)}` : ""}</div>
    ${actions}
  </div>`;
}

export function renderQueuePage(items: QueueItem[]): string {
  const pending = items.filter((i) => i.status === "pending");
  const others = items.filter((i) => i.status !== "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail-Freigabe · vonBuschOS</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 820px; margin: 0 auto; padding: 24px; background: #f5f5f5; color: #1a1a1a; }
  h1 { font-size: 22px; } h2 { font-size: 16px; color: #555; margin-top: 32px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .head { display: flex; align-items: center; gap: 8px; }
  .from { color: #555; font-size: 13px; } .subject { font-weight: 600; margin: 8px 0; }
  .body { background: #fafafa; border: 1px solid #eee; border-radius: 4px; padding: 8px; white-space: pre-wrap; font-size: 13px; max-height: 200px; overflow: auto; }
  .meta { color: #888; font-size: 12px; margin-top: 6px; }
  .actions { margin-top: 12px; display: flex; gap: 8px; }
  button { padding: 8px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .approve { background: #16a34a; color: #fff; } .reject { background: #e5e7eb; color: #333; }
  .empty { color: #999; padding: 24px; text-align: center; }
</style>
</head>
<body>
  <h1>📬 Mail-Freigabe</h1>
  <p class="meta">Ausgehende Mails, die von Agenten vorgeschlagen wurden. Freigabe versendet real über CF <code>send_email</code>.</p>
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
