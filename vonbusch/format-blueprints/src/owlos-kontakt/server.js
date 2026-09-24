// "Ansprechpartner anlegen" — ein owlOS-Kontakt-Workflow als Gadget.
//
// Statt jedes Mal denselben Prompt zu tippen, klickt ein Nicht-Techniker hier auf "Ansprechpartner
// anlegen", gibt Firma + Name (+ optionale Details) ein, und das Gadget spawnt einen KI-Agenten mit
// einem festen, kuratierten Workflow-Prompt. Der Agent bekommt den owlOS-Gatekeeper in seine env
// gereicht (siehe Blueprint-Bindings) und legt den Kontakt approval-pflichtig an.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.owlos)
//
// Endpunkte: NUR die in packages/gatekeeper-owlos/S2-CONTRACT.md dokumentierten owlOS-Routen.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern. Er nennt dem Agenten exakt die
// erlaubten owlOS-Endpunkte + die aus dem SPA-Bundle verifizierten Pflichtfelder — nichts geraten.
function buildPrompt({ firma, vorname, nachname, email, telefon, position }) {
  return `Du bist der Kontakt-Assistent für die owlOS Cloud-ERP-Instanz. Lege den folgenden
Ansprechpartner (Kontakt) sauber an. Ein Kontakt MUSS einer Firma zugeordnet sein.

Firma (Pflicht): ${firma}
Vorname (Pflicht): ${vorname}
Nachname (Pflicht): ${nachname}
E-Mail: ${email || "(keine)"}
Telefon: ${telefon || "(keine)"}
Position: ${position || "(keine)"}

Dir steht owlOS über deine Umgebung als env.owlos zur Verfügung (der owlOS-Gatekeeper). Rufe
ausschließlich diese Methoden namentlich auf — konstruiere keine eigenen HTTP-Pfade und erfinde
keine anderen Feldnamen:
  • await env.owlos.listCompanies()                          — Firmenliste lesen (direkt, kein Approval)
  • await env.owlos.listContacts({ company_id })             — vorhandene Kontakte der Firma lesen (direkt)
  • await env.owlos.listContacts({ search })                 — nach Namen suchen (direkt)
  • await env.owlos.createContact({ company_id, first_name, last_name, email, phone, position,
                                    status:"prospect", is_decision_maker:0 })  — Kontakt anlegen (approval-pflichtig)
  • await env.owlos.mergeContacts({ … })                     — Dubletten zusammenführen (approval-pflichtig)

Gehe strikt in dieser Reihenfolge vor:
  1. Rufe env.owlos.listCompanies() auf und finde die Firma "${firma}". Nimm ihre id als company_id.
     Existiert die Firma nicht eindeutig, melde das und lege NICHTS an — frage nach der richtigen
     Firma (ein Kontakt ohne company_id ist bei owlOS ungültig: "Firma Pflicht").
  2. Rufe env.owlos.listContacts({ company_id }) auf und prüfe, ob "${vorname} ${nachname}" (oder
     sehr ähnlich) dort schon existiert. Wenn ja, melde den Treffer und lege NICHTS doppelt an —
     frage nach, ob trotzdem ein neuer Datensatz oder ein Merge gewünscht ist.
  3. Sonst lege den Kontakt über env.owlos.createContact({ … }) an, mit exakt:
     { company_id: <die gefundene id>, first_name: "${vorname}", last_name: "${nachname}",
       email: ${email ? `"${email}"` : "null"}, phone: ${telefon ? `"${telefon}"` : "null"},
       position: ${position ? `"${position}"` : "null"}, status: "prospect", is_decision_maker: 0 }.
     Übernimm keine weiteren Felder. first_name und last_name sind Pflicht ("Vor- und Nachname sind
     Pflicht") — fehlt eines, frage nach, erfinde nichts. Der Aufruf liefert { status:
     "pending_approval", actionId }.

Die list*-Methoden laufen direkt; alle create*/merge*-Methoden sind approval-pflichtig (sie liefern
{ status: "pending_approval" }) — ein Mensch muss sie freigeben, schreibe nichts vorher. Antworte auf
Deutsch und markiere jede Annahme ausdrücklich als Annahme.`;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Startet den Workflow: spawnt den Agenten und protokolliert den Lauf.
  async launch({ firma, vorname, nachname, email, telefon, position }) {
    firma = (firma ?? "").toString().trim();
    vorname = (vorname ?? "").toString().trim();
    nachname = (nachname ?? "").toString().trim();
    email = (email ?? "").toString().trim();
    telefon = (telefon ?? "").toString().trim();
    position = (position ?? "").toString().trim();
    if (!firma) throw new Error("Firma ist ein Pflichtfeld (ein Kontakt muss einer Firma zugeordnet sein).");
    if (!vorname || !nachname) throw new Error("Vor- und Nachname sind Pflichtfelder.");

    const title = `Kontakt: ${vorname} ${nachname} (${firma})`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ firma, vorname, nachname, email, telefon, position }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ firma, vorname, nachname, title, at: Date.now() });
    await this.ctx.storage.put("runs", runs.slice(0, 50));
    return { ok: true, title };
  }

  async listRuns() {
    return (await this.ctx.storage.get("runs")) ?? [];
  }
}

export default class extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const id = this.env.GADGET_DO.idFromName("singleton");
    const stub = this.env.GADGET_DO.get(id);

    if (request.method === "POST" && url.pathname.endsWith("/launch")) {
      try {
        const body = await request.json();
        const result = await stub.launch(body);
        return Response.json(result);
      } catch (err) {
        return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 400 });
      }
    }
    if (url.pathname.endsWith("/runs")) {
      return Response.json(await stub.listRuns());
    }

    return new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

const SHELL = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ansprechpartner anlegen</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
