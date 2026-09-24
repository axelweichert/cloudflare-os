// "Aktivität festhalten" — ein owlOS-Aktivitäten-Workflow als Gadget.
//
// Statt jedes Mal denselben Prompt zu tippen, klickt ein Nicht-Techniker hier auf "Aktivität
// festhalten", gibt Betreff + Typ (+ optionale Zuordnung/Notiz) ein, und das Gadget spawnt einen
// KI-Agenten mit einem festen, kuratierten Workflow-Prompt. Der Agent bekommt den owlOS-Gatekeeper
// in seine env gereicht (siehe Blueprint-Bindings) und legt die Aktivität approval-pflichtig an.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.owlos)
//
// Endpunkte: NUR die in packages/gatekeeper-owlos/S2-CONTRACT.md dokumentierten owlOS-Routen.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern. Er nennt dem Agenten exakt die
// erlaubten owlOS-Endpunkte + die aus dem SPA-Bundle verifizierten Pflichtfelder — nichts geraten.
function buildPrompt({ betreff, typ, text, firma, kontakt }) {
  return `Du bist der Aktivitäten-Assistent für die owlOS Cloud-ERP-Instanz. Halte die folgende
Aktivität sauber fest und verknüpfe sie mit Firma/Kontakt, soweit angegeben.

Betreff (Pflicht): ${betreff}
Typ: ${typ || "Notiz"}
Text/Notiz: ${text || "(kein)"}
Firma: ${firma || "(keine)"}
Kontakt: ${kontakt || "(keiner)"}

Dir steht owlOS über deine Umgebung als env.owlos zur Verfügung (der owlOS-Gatekeeper). Rufe
ausschließlich diese Methoden namentlich auf — konstruiere keine eigenen HTTP-Pfade und erfinde
keine anderen Feldnamen:
  • await env.owlos.me()                                     — eingeloggten Nutzer + dessen id ermitteln (owner_id)
  • await env.owlos.listCompanies()                          — Firma auflösen (company_id) (direkt)
  • await env.owlos.listContacts({ company_id }) | ({ search }) — Kontakt auflösen (contact_id) (direkt)
  • await env.owlos.listActivities({ company_id }) | ({ contact_id }) — vorhandene Aktivitäten lesen (direkt)
  • await env.owlos.createActivity({ type, subject, body, company_id, contact_id, owner_id, status:"open" })
                                                             — Aktivität anlegen (approval-pflichtig)
  • await env.owlos.setActivityStatus(activityId, { status }) — Status ändern (open/done) (approval-pflichtig)

Gültige Typ-Werte (aus owlOS): "Brief", "E-Mail", "Angebot", "Auftrag", "Auftragsbestätigung",
"Rechnung", "Lieferschein", "Gutschrift", "Mahnung", "Vertrag", "Korrespondenz", "Notiz",
"Sonstige". Ordne den oben genannten Typ dem passenden Wert zu; ist keiner genannt, nimm "Notiz".

Gehe strikt in dieser Reihenfolge vor:
  1. Rufe env.owlos.me() auf und nimm die id des eingeloggten Nutzers als owner_id. Ohne owner_id
     lässt owlOS keine Aktivität zu ("Inhaber fehlt") — fehlt sie, melde das und lege NICHTS an.
  2. Falls eine Firma/ein Kontakt genannt ist, löse sie über env.owlos.listCompanies() bzw.
     env.owlos.listContacts({ … }) zu company_id/contact_id auf. Findest du sie nicht eindeutig,
     frage nach — verknüpfe nichts auf Verdacht (setze das jeweilige Feld sonst auf null).
  3. Lege die Aktivität über env.owlos.createActivity({ … }) an, mit exakt:
     { type: <gültiger Typ>, subject: "${betreff}", body: ${text ? `"${text}"` : `""`},
       company_id: <id oder null>, contact_id: <id oder null>, owner_id: <deine id>,
       status: "open" }. subject (Betreff) ist Pflicht ("Betreff ist Pflicht") — fehlt er, frage
     nach, erfinde nichts. Der Aufruf liefert { status: "pending_approval", actionId }.

Die list*/me-Methoden laufen direkt; alle create*/set*-Methoden sind approval-pflichtig (sie liefern
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
  async launch({ betreff, typ, text, firma, kontakt }) {
    betreff = (betreff ?? "").toString().trim();
    typ = (typ ?? "").toString().trim();
    text = (text ?? "").toString().trim();
    firma = (firma ?? "").toString().trim();
    kontakt = (kontakt ?? "").toString().trim();
    if (!betreff) throw new Error("Betreff ist ein Pflichtfeld.");

    const title = `Aktivität: ${betreff}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ betreff, typ, text, firma, kontakt }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ betreff, typ, title, at: Date.now() });
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
<title>Aktivität festhalten</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
