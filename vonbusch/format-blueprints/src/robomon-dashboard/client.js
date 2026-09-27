// RoboMon Fleet Dashboard — client UI (vanilla JS, no framework).

const STATUS_ICON = {
  idle: "⬜",
  working: "🟩",
  charging: "🔋",
  error: "🔴",
  offline: "⚫",
  docked: "🟦",
};

function statusIcon(s) {
  return STATUS_ICON[s] ?? "❓";
}

function batteryBar(pct) {
  if (pct == null) return "";
  const filled = Math.round((pct / 100) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const color = pct < 20 ? "#e53e3e" : pct < 50 ? "#d69e2e" : "#38a169";
  return `<span style="font-family:monospace;color:${color}" title="${pct}%">${bar} ${pct}%</span>`;
}

function relativeTime(ms) {
  if (!ms) return "–";
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function sectionHeader(title, count) {
  const badge = count != null ? ` <span class="badge">${count}</span>` : "";
  return `<h2>${title}${badge}</h2>`;
}

function errorBox(msg) {
  return msg ? `<div class="error-box">⚠ ${msg}</div>` : "";
}

function renderKpis(kpis, robots) {
  const total = robots.length;
  const active = robots.filter(r => r.status === "working").length;
  const charging = robots.filter(r => r.charging).length;
  const errored = robots.filter(r => r.openErrors > 0 || r.status === "error").length;

  const tile = (label, value, color) =>
    `<div class="kpi-tile" style="border-top:3px solid ${color}">
      <div class="kpi-value">${value}</div>
      <div class="kpi-label">${label}</div>
    </div>`;

  return `<div class="kpi-row">
    ${tile("Roboter gesamt", total, "#4a6fa5")}
    ${tile("Aktiv", active, "#38a169")}
    ${tile("Lädt", charging, "#d69e2e")}
    ${tile("Fehler", errored, errored > 0 ? "#e53e3e" : "#718096")}
    ${kpis.openTickets != null ? tile("Offene Tickets", kpis.openTickets, "#805ad5") : ""}
    ${kpis.pendingAlerts != null ? tile("Ausstehende Alerts", kpis.pendingAlerts, "#dd6b20") : ""}
  </div>`;
}

function renderRobots(robots) {
  if (!robots.length) return "<p class='empty'>Keine Roboter gefunden.</p>";
  const rows = robots.map(r => `
    <tr class="${r.status === "error" || r.openErrors > 0 ? "row-error" : ""}">
      <td>${statusIcon(r.status)} ${r.status}</td>
      <td>${r.name || r.id}</td>
      <td>${r.customerName || r.customerId || "–"}</td>
      <td>${r.zone || "–"}</td>
      <td>${r.task || "–"}</td>
      <td>${batteryBar(r.battery)}</td>
      <td>${relativeTime(r.lastHeartbeat)}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr><th>Status</th><th>Roboter</th><th>Kunde</th><th>Zone</th><th>Aufgabe</th><th>Akku</th><th>Zuletzt</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAlerts(alertData) {
  const list = alertData?.alerts ?? [];
  if (!list.length) return "<p class='empty'>Keine aktiven Alerts.</p>";
  const rows = list.map(a => `
    <tr class="${a.severity === "high" || a.severity === "critical" ? "row-error" : ""}">
      <td>${a.severity || "–"}</td>
      <td>${a.robotId || "–"}</td>
      <td>${a.message || a.type || JSON.stringify(a)}</td>
      <td>${a.at ? relativeTime(a.at) : "–"}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr><th>Schwere</th><th>Roboter</th><th>Nachricht</th><th>Seit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderTickets(tickets) {
  if (!tickets.length) return "<p class='empty'>Keine Tickets.</p>";
  const rows = tickets.map(t => `
    <tr>
      <td><span class="badge badge-${(t.status||"").toLowerCase()}">${t.status || "–"}</span></td>
      <td>${t.kind || t.type || "–"}</td>
      <td>${t.title || t.id || "–"}</td>
      <td>${t.robotId || "–"}</td>
      <td>${t.assignee || "–"}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleDateString("de-DE") : "–"}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr><th>Status</th><th>Art</th><th>Titel</th><th>Roboter</th><th>Bearbeiter</th><th>Erstellt</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderService(svcData) {
  const robots = svcData?.robots ?? [];
  if (!robots.length) return "<p class='empty'>Keine Wartungsdaten.</p>";
  const rows = robots.map(r => {
    const dueClass = r.overdue ? "row-error" : r.dueSoon ? "row-warn" : "";
    return `<tr class="${dueClass}">
      <td>${r.robotId || r.id || "–"}</td>
      <td>${r.name || "–"}</td>
      <td>${r.lastService ? new Date(r.lastService).toLocaleDateString("de-DE") : "–"}</td>
      <td>${r.nextService ? new Date(r.nextService).toLocaleDateString("de-DE") : "–"}</td>
      <td>${r.overdue ? "⚠ Überfällig" : r.dueSoon ? "Bald fällig" : "OK"}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr><th>Roboter-ID</th><th>Name</th><th>Letzter Service</th><th>Nächster Service</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAutomation(rules) {
  if (!rules.length) return "<p class='empty'>Keine Automatisierungsregeln.</p>";
  const rows = rules.map(r => `
    <tr>
      <td>${r.enabled ? "✅" : "⬜"}</td>
      <td>${r.name || r.id || "–"}</td>
      <td>${r.trigger || "–"}</td>
      <td>${r.action || "–"}</td>
      <td>${r.description || "–"}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr><th>Aktiv</th><th>Name</th><th>Auslöser</th><th>Aktion</th><th>Beschreibung</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function render(data) {
  const app = document.getElementById("app");
  if (!app) return;

  const anyError = Object.values(data.errors || {}).some(Boolean);

  app.innerHTML = `
    <style>
      :root { --bg: #f7f8fa; --card: #fff; --border: #e2e8f0; --text: #2d3748; --subtle: #718096; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; }
      #app { max-width: 1100px; margin: 0 auto; padding: 20px; }
      header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
      header h1 { font-size: 1.4rem; font-weight: 600; }
      .ts { font-size: 0.8rem; color: var(--subtle); }
      .kpi-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
      .kpi-tile { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 14px 20px; min-width: 120px; flex: 1; }
      .kpi-value { font-size: 1.8rem; font-weight: 700; }
      .kpi-label { font-size: 0.8rem; color: var(--subtle); margin-top: 4px; }
      section { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; }
      h2 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
      th { background: #f1f5f9; font-weight: 600; }
      tr:last-child td { border-bottom: none; }
      .row-error { background: #fff5f5; }
      .row-warn  { background: #fffbeb; }
      .badge { display: inline-block; background: #e2e8f0; border-radius: 9999px; padding: 1px 8px; font-size: 0.75rem; font-weight: 600; }
      .badge-open   { background: #bee3f8; color: #2c5282; }
      .badge-closed { background: #c6f6d5; color: #276749; }
      .badge-pending { background: #fefcbf; color: #744210; }
      .empty  { color: var(--subtle); font-style: italic; padding: 8px 0; }
      .error-box { background: #fff5f5; border: 1px solid #feb2b2; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; color: #c53030; font-size: 0.83rem; }
      button.refresh { background: #4a6fa5; color: #fff; border: none; border-radius: 5px; padding: 7px 16px; cursor: pointer; font-size: 0.85rem; }
      button.refresh:hover { background: #3a5f95; }
      .loading { opacity: 0.5; pointer-events: none; }
    </style>

    <header>
      <h1>🤖 RoboMon Fleet Dashboard</h1>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="ts">Stand: ${data.ts ? new Date(data.ts).toLocaleTimeString("de-DE") : "–"}</span>
        <button class="refresh" id="btn-refresh">Aktualisieren</button>
      </div>
    </header>

    ${anyError ? `<div class="error-box">Einige Daten konnten nicht geladen werden: ${Object.entries(data.errors).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join("; ")}</div>` : ""}

    ${renderKpis(data.kpis, data.robots)}

    <section id="sec-robots">
      ${sectionHeader("Flottenübersicht", data.robots.length)}
      ${renderRobots(data.robots)}
    </section>

    <section id="sec-alerts">
      ${sectionHeader("Alert-Center", (data.alerts?.alerts ?? []).length)}
      ${renderAlerts(data.alerts)}
    </section>

    <section id="sec-tickets">
      ${sectionHeader("Aufgaben / Tickets", data.tickets.length)}
      ${renderTickets(data.tickets)}
    </section>

    <section id="sec-service">
      ${sectionHeader("Wartung / Verschleiß", (data.service?.robots ?? []).length)}
      ${renderService(data.service)}
    </section>

    <section id="sec-automation">
      ${sectionHeader("Automatisierungsregeln", data.automationRules.length)}
      ${renderAutomation(data.automationRules)}
    </section>
  `;

  document.getElementById("btn-refresh")?.addEventListener("click", loadDashboard);
}

function showLoading() {
  const app = document.getElementById("app");
  if (app) app.classList.add("loading");
}

async function loadDashboard() {
  showLoading();
  try {
    const res = await fetch("./dashboard");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    const app = document.getElementById("app");
    if (app) {
      app.classList.remove("loading");
      app.innerHTML = `<div style="padding:40px;text-align:center;color:#e53e3e">
        <p style="font-size:1.2rem;margin-bottom:8px">Dashboard konnte nicht geladen werden</p>
        <p style="font-size:0.9rem;color:#718096">${err.message}</p>
        <button onclick="loadDashboard()" style="margin-top:16px;padding:8px 20px;cursor:pointer">Erneut versuchen</button>
      </div>`;
    }
  }
}

// Auto-refresh every 60 seconds.
loadDashboard();
setInterval(loadDashboard, 60_000);
