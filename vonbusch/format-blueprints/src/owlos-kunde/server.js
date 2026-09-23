// "Kunde anlegen" — ein owlOS-Firmen-Workflow als Gadget.
//
// Statt jedes Mal denselben Prompt zu tippen, klickt ein Nicht-Techniker hier auf "Kunde
// anlegen", gibt Firmenname (+ optionale Details) ein, und das Gadget spawnt einen KI-Agenten
// mit einem festen, kuratierten Workflow-Prompt. Der Agent bekommt den owlOS-Gatekeeper in seine
// env gereicht (siehe Blueprint-Bindings) und legt den Kunden approval-pflichtig an.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.owlos)
//
// Endpunkte: NUR die in packages/gatekeeper-owlos/S2-CONTRACT.md dokumentierten owlOS-Routen.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern. Er nennt dem Agenten exakt die
// erlaubten owlOS-Endpunkte (aus S2-CONTRACT.md) — nichts wird geraten.
function buildPrompt({ firma, details }) {
  return `Du bist der Kunden-Assistent für die owlOS Cloud-ERP-Instanz. Lege den folgenden Kunden
(Firma) sauber an.

Firma: ${firma}
${details ? `Zusatzangaben: ${details}` : "Zusatzangaben: (keine)"}

Dir steht owlOS über deine Umgebung als env.owlos zur Verfügung (der owlOS-Gatekeeper).
Nutze ausschließlich diese Endpunkte — erfinde keine anderen Routen:
  • GET  /api/companies                     — Kundenliste lesen (direkt, kein Approval)
  • POST /api/companies { name, … }         — Kunde anlegen (approval-pflichtig)
  • POST /api/companies/assign-kundennr      — Kundennummer vergeben (approval-pflichtig)

Gehe strikt in dieser Reihenfolge vor:
  1. Lies GET /api/companies und prüfe, ob "${firma}" (oder ein sehr ähnlicher Name) schon
     existiert. Wenn ja, melde den Treffer und lege NICHTS doppelt an — frage nach, ob trotzdem
     ein neuer Datensatz gewünscht ist.
  2. Sonst lege den Kunden über POST /api/companies mit mindestens { name: "${firma}" } an.
     Übernimm weitere Felder nur, wenn sie oben ausdrücklich genannt sind. Fehlt ein von owlOS
     als Pflicht gefordertes Feld, frage gezielt nach — erfinde keine Werte.
  3. Vergib anschließend über POST /api/companies/assign-kundennr eine Kundennummer für den neuen
     Datensatz.

Reads (GET) laufen direkt; alle Creates (POST) sind approval-pflichtig — ein Mensch muss sie
freigeben, schreibe nichts vorher. Antworte auf Deutsch und markiere jede Annahme ausdrücklich
als Annahme.`;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Startet den Workflow: spawnt den Agenten und protokolliert den Lauf.
  async launch({ firma, details }) {
    firma = (firma ?? "").toString().trim();
    details = (details ?? "").toString().trim();
    if (!firma) {
      throw new Error("Firmenname ist ein Pflichtfeld.");
    }

    const title = `Kunde: ${firma}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ firma, details }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ firma, details, title, at: Date.now() });
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
<title>Kunde anlegen</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
