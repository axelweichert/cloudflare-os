// Read-only UI für den Microsoft-365-Überblick: Posteingang, Termine, Aufgaben in drei Spalten.
// Holt einmalig ./data vom Gadget-Server (der über env.m365.* liest) und rendert das Ergebnis.

const app = document.getElementById("app");
app.innerHTML = `
<style>
  :root { color-scheme: light; --accent:#0078d4; }
  body { margin:0; font:14px ui-sans-serif,system-ui,sans-serif; color:#1d1d20; background:#f6f6f4; }
  .wrap { max-width:1080px; margin:24px auto; padding:0 16px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  h1 { font-size:20px; margin:0 0 2px; }
  .who { color:#6b6b73; font-size:13px; }
  .cols { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-top:18px; }
  @media (max-width:820px){ .cols{ grid-template-columns:1fr; } }
  .col h2 { font-size:14px; margin:0 0 8px; color:#3a3a42; text-transform:uppercase; letter-spacing:.04em; }
  .card { background:#fff; border:1px solid #eae9e4; border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .card b { display:block; font-weight:600; }
  .card small { color:#6b6b73; }
  .muted { color:#8a8a92; }
  .banner { background:#fff4e5; border:1px solid #ffd9a8; border-radius:8px; padding:12px 14px; color:#7a4e00; }
  .err { color:#a00; font-size:12px; margin-top:4px; }
</style>
<div class="wrap">
  <header>
    <div><h1>Microsoft 365 Überblick</h1><div class="who" id="who">lädt …</div></div>
    <div class="muted" style="font-size:12px">nur Lesen</div>
  </header>
  <div id="body"></div>
</div>`;

const $ = (id) => document.getElementById(id);
function esc(s){ return String(s ?? "").replace(/[&<>"]/g,(c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
function when(iso){ if(!iso) return ""; const d=new Date(iso); return isNaN(d)?String(iso):d.toLocaleString("de-DE"); }

function col(title, items, empty, err){
  const body = err
    ? `<div class="err">${esc(err)}</div>`
    : (items.length ? items.join("") : `<div class="muted">${esc(empty)}</div>`);
  return `<div class="col"><h2>${esc(title)}</h2>${body}</div>`;
}

async function load(){
  let data;
  try { data = await (await fetch("./data")).json(); }
  catch(e){ $("who").textContent=""; $("body").innerHTML = `<div class="banner">Konnte das Konto nicht laden: ${esc(e.message)}</div>`; return; }

  if(!data.connected){
    $("who").textContent = "";
    $("body").innerHTML = `<div class="banner"><b>Kein Microsoft-365-Konto verbunden.</b><br>
      Verbinde oben rechts ein Konto (bzw. warte, bis der Gatekeeper konfiguriert ist), dann erscheinen hier Posteingang, Termine und Aufgaben.
      ${data.error ? `<div class="err">${esc(data.error)}</div>` : ""}</div>`;
    return;
  }

  $("who").textContent = `${data.profile.displayName ?? data.profile.email ?? ""}${data.profile.email ? " · " + data.profile.email : ""}`;

  const mail = (data.messages||[]).map(m => `<div class="card">
      <b>${esc(m.subject || "(kein Betreff)")}</b>
      <small>${esc(m.from?.name || m.from?.address || "")}${m.receivedDateTime ? " · " + when(m.receivedDateTime) : ""}${m.isRead ? "" : " · <b>neu</b>"}</small>
      <div class="muted">${esc((m.preview||"").slice(0,120))}</div>
    </div>`);

  const evs = (data.events||[]).map(e => `<div class="card">
      <b>${esc(e.subject || "(ohne Titel)")}</b>
      <small>${esc(when(e.start))}${e.location ? " · " + esc(e.location) : ""}</small>
    </div>`);

  const tks = (data.tasks||[]).map(t => `<div class="card">
      <b>${t.isCompleted ? "✓ " : ""}${esc(t.title || "(ohne Titel)")}</b>
      <small>${t.dueDateTime ? "fällig " + when(t.dueDateTime) : esc(t.status || "")}</small>
    </div>`);

  $("body").innerHTML = `<div class="cols">
    ${col("Posteingang", mail, "Keine Nachrichten.", data.messagesError)}
    ${col("Termine", evs, "Keine anstehenden Termine.", data.eventsError)}
    ${col("Aufgaben", tks, "Keine offenen Aufgaben.", data.tasksError)}
  </div>`;
}

load();
