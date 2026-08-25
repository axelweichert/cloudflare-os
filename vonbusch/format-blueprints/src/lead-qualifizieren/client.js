// Minimal-UI für den "Lead qualifizieren"-Workflow. Lead-Name + optionale Notiz, ein Knopf, und
// die Liste der letzten Läufe. Die Qualifizierung selbst läuft serverseitig im gespawnten Agenten.

const app = document.getElementById("app");
app.innerHTML = `
<style>
  :root { color-scheme: light; --accent:#2c6e8f; }
  body { margin:0; font:14px ui-sans-serif,system-ui,sans-serif; color:#1d1d20; background:#f6f6f4; }
  .wrap { max-width:560px; margin:32px auto; padding:0 16px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.sub { color:#6b6b73; margin:0 0 20px; }
  label { display:block; font-weight:600; margin:14px 0 4px; }
  input, textarea { width:100%; padding:9px 11px; border:1px solid #d5d5d0; border-radius:8px;
    font:inherit; box-sizing:border-box; background:#fff; }
  textarea { min-height:70px; resize:vertical; }
  button { margin-top:18px; padding:10px 18px; border:0; border-radius:8px; background:var(--accent);
    color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .status { margin-top:14px; min-height:20px; }
  .runs { margin-top:28px; }
  .run { padding:10px 12px; background:#fff; border:1px solid #eae9e4; border-radius:8px; margin-top:8px; }
  .run b { display:block; } .run small { color:#6b6b73; }
</style>
<div class="wrap">
  <h1>Lead qualifizieren</h1>
  <p class="sub">Lead eintragen — der Agent bewertet nach BANT, vergibt einen Score und schlägt den nächsten Schritt vor.</p>
  <label for="lead">Lead</label>
  <input id="lead" placeholder="z. B. Muster GmbH / Frau Beispiel">
  <label for="notiz">Notiz (optional)</label>
  <textarea id="notiz" placeholder="z. B. Anfrage über Kontaktformular, Interesse an DMS"></textarea>
  <button id="go">Qualifizieren</button>
  <div class="status" id="status"></div>
  <div class="runs" id="runs"></div>
</div>`;

const $ = (id) => document.getElementById(id);
const status = $("status");

async function refresh() {
  try {
    const runs = await (await fetch("./runs")).json();
    $("runs").innerHTML = runs.length
      ? "<label>Zuletzt geprüft</label>" + runs.map((r) =>
          `<div class="run"><b>${esc(r.title)}</b><small>${esc(r.notiz || "—")} · ${new Date(r.at).toLocaleString("de-DE")}</small></div>`).join("")
      : "";
  } catch { /* Liste ist optional */ }
}

$("go").addEventListener("click", async () => {
  const lead = $("lead").value.trim();
  const notiz = $("notiz").value.trim();
  if (!lead) { status.textContent = "Bitte einen Lead eintragen."; return; }
  $("go").disabled = true;
  status.textContent = "Agent wird gestartet …";
  try {
    const res = await (await fetch("./launch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lead, notiz }),
    })).json();
    status.textContent = res.ok ? `✓ „${res.title}" gestartet.` : `Fehler: ${res.error}`;
    if (res.ok) { $("notiz").value = ""; refresh(); }
  } catch (err) {
    status.textContent = `Fehler: ${err.message}`;
  } finally {
    $("go").disabled = false;
  }
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

refresh();
