// "Angebot anlegen" — ein owlOS-Firmen-Workflow als Gadget.
//
// Statt jedes Mal denselben Prompt zu tippen, klickt ein Nicht-Techniker hier auf "Angebot
// anlegen", gibt Titel (Pflicht) + Kunde ein, und das Gadget spawnt einen KI-Agenten mit einem
// festen, kuratierten Workflow-Prompt. Der Agent bekommt den owlOS-Gatekeeper in seine env
// gereicht (siehe Blueprint-Bindings) und legt das Angebot approval-pflichtig an.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.owlos)
//
// Endpunkte: NUR die in packages/gatekeeper-owlos/S2-CONTRACT.md dokumentierten owlOS-Routen.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern. Er nennt dem Agenten exakt die
// erlaubten owlOS-Endpunkte (aus S2-CONTRACT.md) — nichts wird geraten.
function buildPrompt({ titel, kunde }) {
  return `Du bist der Angebots-Assistent für die owlOS Cloud-ERP-Instanz. Lege das folgende
Angebot (Quote) sauber an.

Titel: ${titel}
${kunde ? `Kunde: ${kunde}` : "Kunde: (nicht angegeben)"}

Dir steht owlOS über deine Umgebung als env.owlos zur Verfügung (der owlOS-Gatekeeper).
Nutze ausschließlich diese Endpunkte — erfinde keine anderen Routen:
  • GET   /api/erp/quotes                 — Angebotsliste lesen (direkt, kein Approval)
  • POST  /api/erp/quotes { title }       — Angebot anlegen; "title" ist PFLICHT (approval-pflichtig)
  • PATCH /api/erp/quotes/{id}            — Angebot ergänzen, u. a. "company_id" setzen (approval-pflichtig)

Gehe strikt in dieser Reihenfolge vor:
  1. Lies GET /api/erp/quotes, um dir einen Überblick über bestehende Angebote zu verschaffen und
     erkennbare Dubletten zum Titel "${titel}" zu melden.
  2. Lege das Angebot über POST /api/erp/quotes mit { title: "${titel}" } an. Der Titel ist ein
     owlOS-Pflichtfeld ("Titel ist Pflicht") — ohne Titel nicht anlegen.
  3. Wenn ein Kunde genannt ist, ermittle dessen company_id (owlOS-Kundenkontext) und setze sie am
     neuen Angebot über PATCH /api/erp/quotes/{id} ({ company_id }). Kennst du die company_id nicht
     eindeutig, frage nach — rate keine ID.

Übernimm nur Feldwerte, die oben ausdrücklich genannt sind. Fehlt ein von owlOS als Pflicht
gefordertes Feld, frage gezielt nach — erfinde keine Werte. Reads (GET) laufen direkt; alle Creates
und Änderungen (POST/PATCH) sind approval-pflichtig — ein Mensch muss sie freigeben, schreibe nichts
vorher. Antworte auf Deutsch und markiere jede Annahme ausdrücklich als Annahme.`;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Startet den Workflow: spawnt den Agenten und protokolliert den Lauf.
  async launch({ titel, kunde }) {
    titel = (titel ?? "").toString().trim();
    kunde = (kunde ?? "").toString().trim();
    if (!titel) {
      throw new Error("Titel ist ein Pflichtfeld (owlOS: „Titel ist Pflicht“).");
    }

    const title = `Angebot: ${titel}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ titel, kunde }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ titel, kunde, title, at: Date.now() });
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
<title>Angebot anlegen</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
