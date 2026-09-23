// Minimal-UI für den "Ansprechpartner anlegen"-Workflow. Ein Formular (Firma + Name + optionale
// Details), ein Knopf, und die Liste der zuletzt gestarteten Läufe. Der eigentliche Workflow läuft
// serverseitig im gespawnten Agenten — dieses UI ist nur der Auslöser für Nicht-Techniker.

const app = document.getElementById("app");
app.innerHTML = `
<style>
  :root { color-scheme: light; --accent:#677979; }
  body { margin:0; font:14px ui-sans-serif,system-ui,sans-serif; color:#1d1d20; background:#f6f6f4; }
  .wrap { max-width:560px; margin:32px auto; padding:0 16px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.sub { color:#6b6b73; margin:0 0 20px; }
  label { display:block; font-weight:600; margin:14px 0 4px; }
  input { width:100%; padding:9px 11px; border:1px solid #d5d5d0; border-radius:8px;
    font:inherit; box-sizing:border-box; background:#fff; }
  .row { display:flex; gap:12px; }
  .row > div { flex:1; }
  button { margin-top:18px; padding:10px 18px; border:0; border-radius:8px; background:var(--accent);
    color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .status { margin-top:14px; min-height:20px; }
  .runs { margin-top:28px; }
  .run { padding:10px 12px; background:#fff; border:1px solid #eae9e4; border-radius:8px; margin-top:8px; }
  .run b { display:block; } .run small { color:#6b6b73; }
</style>
<div class="wrap">
  <h1>Ansprechpartner anlegen</h1>
  <p class="sub">Firma + Name eintragen — der Kontakt-Agent ordnet den Ansprechpartner der Firma zu, prüft owlOS auf Dubletten und legt ihn approval-pflichtig an.</p>
  <label for="firma">Firma <span style="font-weight:400;color:#a00">*</span></label>
  <input id="firma" placeholder="z. B. Musterbau GmbH">
  <div class="row">
    <div><label for="vorname">Vorname *</label><input id="vorname" placeholder="Erika"></div>
    <div><label for="nachname">Nachname *</label><input id="nachname" placeholder="Mustermann"></div>
  </div>
  <div class="row">
    <div><label for="email">E-Mail</label><input id="email" placeholder="optional"></div>
    <div><label for="telefon">Telefon</label><input id="telefon" placeholder="optional"></div>
  </div>
  <label for="position">Position</label>
  <input id="position" placeholder="optional, z. B. Einkauf">
  <button id="go">Ansprechpartner anlegen</button>
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
          `<div class="run"><b>${esc(r.title)}</b><small>${new Date(r.at).toLocaleString("de-DE")}</small></div>`).join("")
      : "";
  } catch { /* Liste ist optional */ }
}

$("go").addEventListener("click", async () => {
  const firma = $("firma").value.trim();
  const vorname = $("vorname").value.trim();
  const nachname = $("nachname").value.trim();
  if (!firma) { status.textContent = "Bitte Firma ausfüllen (Pflicht)."; return; }
  if (!vorname || !nachname) { status.textContent = "Bitte Vor- und Nachname ausfüllen (Pflicht)."; return; }
  $("go").disabled = true;
  status.textContent = "Agent wird gestartet …";
  try {
    const res = await (await fetch("./launch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firma, vorname, nachname,
        email: $("email").value.trim(), telefon: $("telefon").value.trim(), position: $("position").value.trim(),
      }),
    })).json();
    status.textContent = res.ok ? `✓ „${res.title}" gestartet.` : `Fehler: ${res.error}`;
    if (res.ok) {
      $("vorname").value = ""; $("nachname").value = ""; $("email").value = "";
      $("telefon").value = ""; $("position").value = ""; refresh();
    }
  } catch (err) {
    status.textContent = `Fehler: ${err.message}`;
  } finally {
    $("go").disabled = false;
  }
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

refresh();
