// vonBuschOS — Preiserhebungs-Gatekeeper Worker (VON-1801)
//
// Dünner WorkerEntrypoint um PreiserhebungSession. Exponiert die Preis-Engines
// (printgemein-Druckpreis + DMS-ROI) als read-only Gadget-Baustein. Der Vertrieb
// justiert Parameter zur Laufzeit per `overrides` — die Preis-D1 bleibt read-only.
//
// Bindings (wrangler.jsonc):
//   PREIS_DB (D1, read-only)  — printgemein `preisparameter`-Tabelle
//
// HTTP (für E2E unter `wrangler dev`; die eigentliche Gadget-Anbindung läuft
// über die RPC-Session der PreiserhebungSession):
//   POST /calc/druck  { konfiguration, overrides? }  → PreisAufschluesselung
//   POST /calc/roi    { eingabe, overrides? }         → DmsRoiErgebnis
//   GET  /parameter                                   → PreisParameterSatz (D1, read-only)

import { WorkerEntrypoint } from "cloudflare:workers";
import { PreiserhebungSession, type PreisRepo } from "./session.ts";
import type { PreisparameterRow } from "./preis-parameter.ts";
import { PreisValidierungsFehler } from "./engine/printgemein-preis.ts";

type Env = {
  PREIS_DB: D1Database;
};

// D1-gestütztes, ausschließlich lesendes Repo. Lädt je schluessel den aktiven
// Wert mit der neuesten gueltig_ab.
class D1PreisRepo implements PreisRepo {
  #db: D1Database;
  constructor(db: D1Database) {
    this.#db = db;
  }

  async ladeDruckparameter(): Promise<PreisparameterRow[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT schluessel, wert FROM preisparameter p
         WHERE aktiv = 1
           AND gueltig_ab = (
             SELECT MAX(gueltig_ab) FROM preisparameter p2
             WHERE p2.schluessel = p.schluessel AND p2.aktiv = 1
           )`,
      )
      .all<PreisparameterRow>();
    return results ?? [];
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default class PreiserhebungWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const session = new PreiserhebungSession(new D1PreisRepo(this.env.PREIS_DB));

    try {
      if (request.method === "GET" && url.pathname === "/parameter") {
        return json(await session.getDruckparameter());
      }
      if (request.method === "POST" && url.pathname === "/calc/druck") {
        const { konfiguration, overrides } = await request.json<any>();
        return json(await session.berechneDruckPreis(konfiguration, overrides));
      }
      if (request.method === "POST" && url.pathname === "/calc/roi") {
        const { eingabe, overrides } = await request.json<any>();
        return json(await session.berechneDmsRoi(eingabe ?? {}, overrides));
      }
      return new Response("Not Found", { status: 404 });
    } catch (e) {
      if (e instanceof PreisValidierungsFehler) {
        return json({ fehler: e.message }, 422);
      }
      return json({ fehler: (e as Error).message ?? "Interner Fehler" }, 500);
    }
  }
}
