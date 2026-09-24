// "Opportunity anlegen" — ein owlOS-Deal-Workflow als Gadget.
//
// owlOS nennt Opportunities intern "Deals". Statt jedes Mal denselben Prompt zu tippen, klickt ein
// Nicht-Techniker hier auf "Opportunity anlegen", gibt Titel + Firma (+ Stufe/Wert) ein, und das
// Gadget spawnt einen KI-Agenten mit einem festen, kuratierten Workflow-Prompt. Der Agent bekommt
// den owlOS-Gatekeeper in seine env gereicht und legt die Opportunity approval-pflichtig an.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.owlos)
//
// Endpunkte: NUR die in packages/gatekeeper-owlos/S2-CONTRACT.md dokumentierten owlOS-Routen.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern. Er nennt dem Agenten exakt die
// erlaubten owlOS-Endpunkte + die aus dem SPA-Bundle verifizierten Pflichtfelder — nichts geraten.
function buildPrompt({ titel, firma, stufe, wert, wahrscheinlichkeit }) {
  return `Du bist der Opportunity-Assistent für die owlOS Cloud-ERP-Instanz. owlOS nennt
Opportunities intern "Deals". Lege die folgende Opportunity in der Vertriebs-Pipeline sauber an.

Titel (Pflicht): ${titel}
Firma: ${firma || "(keine)"}
Stufe (stage): ${stufe || "lead"}
Wert (value, netto/brutto wie angegeben): ${wert || "(nicht angegeben)"}
Wahrscheinlichkeit (probability, %): ${wahrscheinlichkeit || "(nicht angegeben)"}

Dir steht owlOS über deine Umgebung als env.owlos zur Verfügung (der owlOS-Gatekeeper). Rufe
ausschließlich diese Methoden namentlich auf — konstruiere keine eigenen HTTP-Pfade und erfinde
keine anderen Feldnamen:
  • await env.owlos.me()                                     — eingeloggten Nutzer + dessen id ermitteln (owner_id)
  • await env.owlos.listCompanies()                          — Firma auflösen (company_id) (direkt)
  • await env.owlos.listDeals({ company_id }) | ({ status:"open" }) — vorhandene Deals lesen (direkt)
  • await env.owlos.createDeal({ title, company_id, owner_id, stage, value, probability })
                                                             — Deal anlegen (approval-pflichtig)

Gültige stage-Werte (aus owlOS): "lead" (Erstkontakt), "qualified" (Qualifiziert),
"proposal" (Angebot), "negotiation" (Verhandlung), "won" (Gewonnen). Ordne die oben genannte Stufe
dem passenden Wert zu; ist keine genannt, nimm "lead".

Gehe strikt in dieser Reihenfolge vor:
  1. Rufe env.owlos.me() auf und nimm die id des eingeloggten Nutzers als owner_id. Ohne owner_id
     lässt owlOS keinen Deal zu ("Kein eingeloggter User für Deal-Anlage") — fehlt sie, melde das
     und lege NICHTS an.
  2. Falls eine Firma genannt ist, löse sie über env.owlos.listCompanies() zu company_id auf. Findest
     du sie nicht eindeutig, frage nach — verknüpfe nichts auf Verdacht (setze company_id sonst auf
     null). Prüfe mit env.owlos.listDeals({ company_id }), ob ein sehr ähnlicher Deal schon existiert,
     und lege nichts doppelt an.
  3. Lege den Deal über env.owlos.createDeal({ … }) an, mit exakt:
     { title: "${titel}", company_id: <id oder null>, owner_id: <deine id>,
       stage: <gültige Stufe>, value: <Zahl oder 0>, probability: <Zahl 0–100 oder 0> }.
     title ist Pflicht — fehlt er, frage nach, erfinde nichts. Übernimm value/probability nur aus
     den obigen Angaben; ohne Angabe setze value: 0 und probability: 0. Der Aufruf liefert
     { status: "pending_approval", actionId }.

Die list*/me-Methoden laufen direkt; alle create*-Methoden sind approval-pflichtig (sie liefern
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
  async launch({ titel, firma, stufe, wert, wahrscheinlichkeit }) {
    titel = (titel ?? "").toString().trim();
    firma = (firma ?? "").toString().trim();
    stufe = (stufe ?? "").toString().trim();
    wert = (wert ?? "").toString().trim();
    wahrscheinlichkeit = (wahrscheinlichkeit ?? "").toString().trim();
    if (!titel) throw new Error("Titel ist ein Pflichtfeld.");

    const title = `Opportunity: ${titel}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ titel, firma, stufe, wert, wahrscheinlichkeit }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ titel, firma, stufe, title, at: Date.now() });
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
<title>Opportunity anlegen</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
