// "Rechnung anlegen" — ein owlOS-Firmen-Workflow als Gadget.
//
// Statt jedes Mal denselben Prompt zu tippen, klickt ein Nicht-Techniker hier auf "Rechnung
// anlegen", gibt Kunde + Positionen ein, und das Gadget spawnt einen KI-Agenten mit einem festen,
// kuratierten Workflow-Prompt. Der Agent bekommt den owlOS-Gatekeeper in seine env gereicht (siehe
// Blueprint-Bindings) und legt die Ausgangsrechnung approval-pflichtig an.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.owlos)
//
// Endpunkte: NUR die in packages/gatekeeper-owlos/S2-CONTRACT.md dokumentierten owlOS-Routen.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern. Er nennt dem Agenten exakt die
// erlaubten owlOS-Endpunkte (aus S2-CONTRACT.md) — nichts wird geraten.
function buildPrompt({ kunde, positionen }) {
  return `Du bist der Rechnungs-Assistent für die owlOS Cloud-ERP-Instanz. Lege die folgende
Ausgangsrechnung (Faktura) sauber an.

Kunde: ${kunde}
Positionen / Angaben:
${positionen}

Dir steht owlOS über deine Umgebung als env.owlos zur Verfügung (der owlOS-Gatekeeper). Rufe
ausschließlich diese Methoden namentlich auf — konstruiere keine eigenen HTTP-Pfade:
  • await env.owlos.listInvoices()                     — Ausgangsrechnungen lesen (direkt, kein Approval)
  • await env.owlos.createInvoice({ doc_type, … })     — Rechnungskopf anlegen; doc_type standardmäßig
                                                       "invoice" (Variante "credit_note") (approval-pflichtig)
  • await env.owlos.addInvoiceItems(invoiceId, { … })  — Positionen zur Rechnung hinzufügen (approval-pflichtig)
  • await env.owlos.finalizeInvoice(invoiceId)         — Rechnung festschreiben/finalisieren (approval-pflichtig)
  • await env.owlos.listCompanies()                    — Kundenliste lesen, um die company_id zu ermitteln (direkt)

Gehe strikt in dieser Reihenfolge vor:
  1. Rufe env.owlos.listInvoices() auf, um dir einen Überblick zu verschaffen und erkennbare Dubletten
     für Kunde "${kunde}" zu melden.
  2. Lege den Rechnungskopf über env.owlos.createInvoice({ doc_type: "invoice", … }) an (nutze
     "credit_note" nur, wenn ausdrücklich eine Gutschrift gewünscht ist). Ermittle die company_id des
     Kunden vorab über env.owlos.listCompanies() und verknüpfe nur eine eindeutig ermittelte ID — rate
     keine ID. Der Aufruf liefert { status: "pending_approval", actionId }.
  3. Füge die oben genannten Positionen über env.owlos.addInvoiceItems(invoiceId, { … }) hinzu.
     Übernimm Mengen, Einzelpreise und Texte nur so, wie sie oben stehen — erfinde keine Beträge.
  4. Prüfe die Rechnung und finalisiere sie erst nach Freigabe über
     env.owlos.finalizeInvoice(invoiceId).

Fehlt ein von owlOS als Pflicht gefordertes Feld (z. B. Position ohne Preis oder Menge), frage
gezielt nach — erfinde keine Werte. Die list*-Methoden laufen direkt; alle create*/add*/finalize*-
Methoden sind approval-pflichtig (sie liefern { status: "pending_approval" }) — ein Mensch muss sie
freigeben, schreibe nichts vorher. Antworte auf Deutsch und markiere jede Annahme ausdrücklich als
Annahme.`;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Startet den Workflow: spawnt den Agenten und protokolliert den Lauf.
  async launch({ kunde, positionen }) {
    kunde = (kunde ?? "").toString().trim();
    positionen = (positionen ?? "").toString().trim();
    if (!kunde || !positionen) {
      throw new Error("Kunde und Positionen sind Pflichtfelder.");
    }

    const title = `Rechnung: ${kunde}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ kunde, positionen }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ kunde, positionen, title, at: Date.now() });
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
<title>Rechnung anlegen</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
