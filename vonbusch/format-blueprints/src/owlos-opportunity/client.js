// Minimal-UI für den "Opportunity anlegen"-Workflow. Ein Formular (Titel + Firma + Stufe/Wert),
// ein Knopf, und die Liste der zuletzt gestarteten Läufe. Der eigentliche Workflow läuft
// serverseitig im gespawnten Agenten — dieses UI ist nur der Auslöser für Nicht-Techniker.

const STUFEN = [
  ["lead", "Erstkontakt"], ["qualified", "Qualifiziert"], ["proposal", "Angebot"],
  ["negotiation", "Verhandlung"], ["won", "Gewonnen"],
];

const app = document.getElementById("app");
app.innerHTML = `
<style>
  :root { color-scheme: light; --accent:#677979; }
  body { margin:0; font:14px ui-sans-serif,system-ui,sans-serif; color:#1d1d20; background:#f6f6f4; }
  .wrap { max-width:560px; margin:32px auto; padding:0 16px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.sub { color:#6b6b73; margin:0 0 20px; }
  label { display:block; font-weight:600; margin:14px 0 4px; }
  input, select { width:100%; padding:9px 11px; border:1px solid #d5d5d0; border-radius:8px;
    font:inherit; box-sizing:border-box; background:#fff; }
  .row { display:flex; gap:12px; } .row > div { flex:1; }
  button { margin-top:18px; padding:10px 18px; border:0; border-radius:8px; background:var(--accent);
    color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .status { margin-top:14px; min-height:20px; }
  .runs { margin-top:28px; }
  .run { padding:10px 12px; background:#fff; border:1px solid #eae9e4; border-radius:8px; margin-top:8px; }
  .run b { display:block; } .run small { color:#6b6b73; }
</style>
<div class="wrap">
  <h1>Opportunity anlegen</h1>
  <p class="sub">Titel + Firma eintragen — der Opportunity-Agent ermittelt den Inhaber, verknüpft die Firma und legt den Deal in der Pipeline approval-pflichtig an. (owlOS nennt Opportunities „Deals".)</p>
  <label for="titel">Titel <span style="font-weight:400;color:#a00">*</span></label>
  <input id="titel" placeholder="z. B. Erweiterung Lagerhalle">
  <label for="firma">Firma</label>
  <input id="firma" placeholder="optional — zum Verknüpfen">
  <div class="row">
    <div><label for="stufe">Stufe</label><select id="stufe">${STUFEN.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>
    <div><label for="wert">Wert (€)</label><input id="wert" placeholder="optional" inputmode="decimal"></div>
    <div><label for="wahrscheinlichkeit">Wahrsch. (%)</label><input id="wahrscheinlichkeit" placeholder="optional" inputmode="numeric"></div>
  </div>
  <button id="go">Opportunity anlegen</button>
  <div class="status" id="status"></div>
  <div class="runs" id="runs"></div>
</div>`;

const $ = (id) => document.getElementById(id);
const status = $("status");

async function refresh() {
  try {
    const runs = await (await fetch("./runs")).json();
    $("runs").innerHTML = runs.length
      ? "<label>Zuletzt gestartet</label>" + runs.map((r) =>
          `<div class="run"><b>${esc(r.title)}</b><small>${esc(r.firma || "—")} · ${esc(r.stufe || "lead")} · ${new Date(r.at).toLocaleString("de-DE")}</small></div>`).join("")
      : "";
  } catch { /* Liste ist optional */ }
}

$("go").addEventListener("click", async () => {
  const titel = $("titel").value.trim();
  if (!titel) { status.textContent = "Bitte Titel ausfüllen (Pflicht)."; return; }
  $("go").disabled = true;
  status.textContent = "Agent wird gestartet …";
  try {
    const res = await (await fetch("./launch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        titel, firma: $("firma").value.trim(), stufe: $("stufe").value,
        wert: $("wert").value.trim(), wahrscheinlichkeit: $("wahrscheinlichkeit").value.trim(),
      }),
    })).json();
    status.textContent = res.ok ? `✓ „${res.title}" gestartet.` : `Fehler: ${res.error}`;
    if (res.ok) { $("firma").value = ""; $("wert").value = ""; $("wahrscheinlichkeit").value = ""; refresh(); }
  } catch (err) {
    status.textContent = `Fehler: ${err.message}`;
  } finally {
    $("go").disabled = false;
  }
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

refresh();
