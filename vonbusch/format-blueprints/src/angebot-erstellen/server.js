// "Angebot erstellen" — ein von-Busch-Firmen-Workflow als Gadget.
//
// Statt jedes Mal denselben langen Prompt zu tippen, klickt ein Nicht-Techniker hier auf
// "Angebot erstellen", gibt Kunde + Anfrage ein, und das Gadget spawnt einen KI-Agenten mit
// einem festen, kuratierten Workflow-Prompt. Der Agent bekommt die CRM- und Preiserhebungs-
// Gatekeeper in seine env gereicht (siehe Blueprint-Bindings) und erledigt die Schritte.
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.crm und env.preise)

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Der kuratierte Workflow-Prompt. DAS ist der Blueprint-Kern: die Firmen-Vorlage, die sonst als
// Copy-&-Paste-Einzelprompt in irgendeinem Chat verrottet. Platzhalter werden vor dem Spawn
// eingesetzt.
function buildPrompt({ kunde, anfrage }) {
  return `Du bist der Angebots-Assistent von von Busch Digital. Erstelle einen sauberen,
kalkulierten Angebotsentwurf für die folgende Anfrage.

Kunde: ${kunde}
Anfrage: ${anfrage}

Dir stehen zwei Werkzeuge über deine Umgebung zur Verfügung:
  • env.crm     — CRM-Gatekeeper (Kontakte, Deals, Aktivitäten). Reads direkt; Writes sind
                  approval-pflichtig, d. h. ein Mensch muss sie freigeben.
  • env.preise  — Preiserhebungs-Gatekeeper (read-only Druck-/DMS-Kalkulationsparameter).

Gehe strikt in dieser Reihenfolge vor:
  1. Suche den Kontakt/Deal zu "${kunde}" über env.crm. Wenn mehrere passen, liste sie auf und
     frage nach, statt zu raten.
  2. Leite aus der Anfrage die Kalkulationsparameter ab (Produkt, Auflage, Format, Seiten,
     Papier, Veredelung bzw. DMS-Nutzerzahl/Belegvolumen). Fehlt etwas Preisrelevantes, frage
     gezielt nach — erfinde keine Werte.
  3. Hole den Preis über env.preise mit exakt diesen Parametern. Nenne Netto, MwSt. und Brutto.
  4. Formuliere den Angebotsentwurf: Anrede, Leistungsbeschreibung, Positionen mit Einzel- und
     Gesamtpreis, Lieferzeit, Gültigkeit 14 Tage, Zahlungsziel 14 Tage netto.
  5. Lege den Entwurf als CRM-Aktivität am Deal an (env.crm) — das ist ein approval-pflichtiger
     Write. Schreibe nichts, bevor der Mensch freigegeben hat.

Antworte auf Deutsch. Halte dich an echte, aus CRM/Preiserhebung stammende Zahlen; markiere jede
Annahme ausdrücklich als Annahme.`;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Startet den Workflow: spawnt den Agenten und protokolliert den Lauf.
  async launch({ kunde, anfrage }) {
    kunde = (kunde ?? "").toString().trim();
    anfrage = (anfrage ?? "").toString().trim();
    if (!kunde || !anfrage) {
      throw new Error("Kunde und Anfrage sind Pflichtfelder.");
    }

    const title = `Angebot: ${kunde}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ kunde, anfrage }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ kunde, anfrage, title, at: Date.now() });
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
<title>Angebot erstellen</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
