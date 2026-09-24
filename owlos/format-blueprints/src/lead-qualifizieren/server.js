// "Lead qualifizieren" — ein von-Busch-Firmen-Workflow als Gadget.
//
// Ein Nicht-Techniker gibt einen Lead-Namen (oder eine kurze Notiz) ein und klickt "Qualifizieren".
// Das Gadget spawnt einen Agenten mit dem festen BANT-Qualifizierungs-Prompt. Der Agent bekommt
// den CRM-Gatekeeper in seine env gereicht (siehe Blueprint-Bindings).
//
// Runtime-Bindings (aus dem Blueprint):
//   env.WORKFLOW  — AgentSpawnerBinding: env.WORKFLOW.spawn(title, prompt)
//   (der gespawnte Agent — nicht dieses Gadget — sieht env.crm)

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

function buildPrompt({ lead, notiz }) {
  return `Du bist der Lead-Qualifizierungs-Assistent von von Busch Digital. Qualifiziere den
folgenden Lead nach BANT und vergib einen Score von 0–100.

Lead: ${lead}
${notiz ? `Notiz: ${notiz}` : ""}

Dir steht ein Werkzeug über deine Umgebung zur Verfügung:
  • env.crm — CRM-Gatekeeper (Kontakte, Deals, Aktivitäten). Reads direkt; Writes sind
              approval-pflichtig (ein Mensch gibt sie frei).

Gehe strikt in dieser Reihenfolge vor:
  1. Finde den Lead/Kontakt "${lead}" über env.crm. Fasse zusammen, was schon bekannt ist
     (Firma, Ansprechpartner, bisherige Aktivitäten, offene Deals).
  2. Bewerte nach BANT und begründe jede Achse kurz:
       • Budget    — gibt es Budgethinweise?
       • Authority — ist der Kontakt Entscheider?
       • Need      — wie konkret ist der Bedarf?
       • Timeline  — gibt es einen Zeithorizont?
     Fehlt Information zu einer Achse, markiere sie ausdrücklich als „unbekannt" — nicht raten.
  3. Vergib einen Gesamt-Score 0–100 und eine Kategorie: heiß (≥70), warm (40–69), kalt (<40).
  4. Empfiehl den nächsten konkreten Schritt (z. B. Erstgespräch, Angebot, nachfassen in 2 Wochen,
     disqualifizieren) mit einer Begründung in einem Satz.
  5. Lege das Ergebnis (Score, BANT-Notizen, nächster Schritt) als CRM-Aktivität am Lead an
     (env.crm) — das ist ein approval-pflichtiger Write. Schreibe erst nach Freigabe.

Antworte auf Deutsch, kompakt und entscheidungsreif.`;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async launch({ lead, notiz }) {
    lead = (lead ?? "").toString().trim();
    notiz = (notiz ?? "").toString().trim();
    if (!lead) {
      throw new Error("Lead ist ein Pflichtfeld.");
    }

    const title = `Lead-Check: ${lead}`;
    await this.env.WORKFLOW.spawn(title, buildPrompt({ lead, notiz }));

    const runs = (await this.ctx.storage.get("runs")) ?? [];
    runs.unshift({ lead, notiz, title, at: Date.now() });
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
<title>Lead qualifizieren</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
