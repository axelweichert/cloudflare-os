// Preiserhebungs-Gatekeeper-Port (VON-1816) — workerd-freier Test der PORT-Schicht.
//
// Lauf:  node --import tsx --test __tests__/observations.test.ts
//
// Belegt die Autorisierungs-Semantik des Ports (jede der vier Reads läuft vor Rückgabe durch
// `authorizeObservation()`; ein ablehnender Authorizer blockiert die Beobachtung) UND dass der
// aus VON-1801 transplantierte Rechenkern durch die Observations-Schicht hindurch identische
// Referenzwerte liefert. Die Vendor/DO-RPC-Hülle (`gadget.ts`) verlangt echtes workerd und wird
// über den `wrangler deploy --dry-run` (Build) sowie `tsc` (Typen) mitgeprüft.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { PreiserhebungSession, type PreisRepo } from "../src/session.ts";
import { PreiserhebungObservations } from "../src/observations.ts";
import type { PreisparameterRow } from "../src/preis-parameter.ts";
import { DMS_ROI_CONFIG } from "../src/engine/dms-roi.ts";

// In-Memory-Repo, zählt Reads (belegt read-only: keine Schreibmethode).
class FakeRepo implements PreisRepo {
  reads = 0;
  constructor(private rows: PreisparameterRow[]) {}
  async ladeDruckparameter(): Promise<PreisparameterRow[]> {
    this.reads++;
    return this.rows.map((r) => ({ ...r }));
  }
}

// Overseer-Double: zeichnet jede Observation auf und kann sie ablehnen (wie robomon-Test).
class RecordingAuthorizer {
  titles: string[] = [];
  constructor(private allow = true) {}
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.titles.push(description.title);
    if (!this.allow) throw new Error("authorization rejected");
  }
}

const REF_KONFIG = {
  format: "A4" as const,
  farbigkeit: "4c" as const,
  papiersorte: "standard_75",
  seiten: 16,
  auflage: 500,
  versand: "standard" as const,
};

function newObs(rows: PreisparameterRow[] = [], allow = true) {
  const repo = new FakeRepo(rows);
  const auth = new RecordingAuthorizer(allow);
  const obs = new PreiserhebungObservations(new PreiserhebungSession(repo), auth);
  return { repo, auth, obs };
}

// ---------------------------------------------------------------------------
// 1. Jede der vier Reads ist durch authorizeObservation() gated.

test("alle vier Observations laufen durch authorizeObservation()", async () => {
  const { auth, obs } = newObs();
  await obs.getDruckparameter();
  await obs.berechneDruckPreis(REF_KONFIG);
  await obs.getDmsRoiConfig();
  await obs.berechneDmsRoi(DMS_ROI_CONFIG.defaults);
  assert.equal(auth.titles.length, 4);
  assert.ok(auth.titles.some((t) => t.includes("Druckpreis")));
  assert.ok(auth.titles.some((t) => t.includes("DMS-ROI")));
});

// ---------------------------------------------------------------------------
// 2. Ablehnender Authorizer blockiert die Beobachtung — kein Datenrückfluss.

test("ablehnender Authorizer blockiert jede Read", async () => {
  const { auth, obs } = newObs([], false);
  await assert.rejects(() => obs.getDruckparameter(), /authorization rejected/);
  await assert.rejects(() => obs.berechneDruckPreis(REF_KONFIG), /authorization rejected/);
  await assert.rejects(() => obs.berechneDmsRoi(DMS_ROI_CONFIG.defaults), /authorization rejected/);
  // Das Gate wurde für jede Read erreicht (compute → authorize → return; die Ablehnung greift
  // VOR der Rückgabe, daher kommt nie ein Wert zurück).
  assert.equal(auth.titles.length, 3);
});

// ---------------------------------------------------------------------------
// 3. Engine-Parität durch die Port-Schicht: transplantierter Rechenkern unverändert.

test("Referenzkonfiguration liefert durch die Observations-Schicht die bekannten Werte", async () => {
  const { obs } = newObs(); // reiner Fallback-Satz (PLATZHALTER_PARAMETER)
  const r = await obs.berechneDruckPreis(REF_KONFIG);
  assert.equal(r.druckNetto, 699); // 35 + 640 + 24
  assert.equal(r.netto, 741.85); // 699 × 1,05 + 7,90
  assert.equal(r.brutto, 793.78);
});

test("DMS-ROI-Default durch die Observations-Schicht = VON-1801-Referenz", async () => {
  const { obs } = newObs();
  const r = await obs.berechneDmsRoi(DMS_ROI_CONFIG.defaults);
  assert.equal(r.docsPerYear, 24000);
  assert.ok(Math.abs(r.annualSavings - 60216) < 1e-6);
});

// ---------------------------------------------------------------------------
// 4. Vertriebs-Overrides bleiben nicht-persistent (D1-Quelle read-only, unangetastet).

test("Overrides justieren nur den Aufruf; die Quelle wird nur read-only berührt", async () => {
  const { repo, obs } = newObs([{ schluessel: "provisionRate", wert: 0.05 }]);
  const basis = await obs.getDruckparameter();
  assert.equal(basis.provisionRate, 0.05);
  const mit = await obs.getDruckparameter({ provisionRate: 0.12 });
  assert.equal(mit.provisionRate, 0.12);
  const wieder = await obs.getDruckparameter();
  assert.equal(wieder.provisionRate, 0.05); // nichts persistiert
  assert.equal(repo.reads, 3); // ausschließlich Reads
});
