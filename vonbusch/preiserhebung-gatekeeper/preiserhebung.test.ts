// vonBuschOS — Tests Preiserhebungs-Gatekeeper (VON-1801)
// Workerd-frei: node:test + In-Memory-Repo. Lauf:  npx tsx --test preiserhebung.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { berechnePreis, PLATZHALTER_PARAMETER } from "./engine/printgemein-preis.ts";
import { computeRoi, DMS_ROI_CONFIG } from "./engine/dms-roi.ts";
import { baueParametersatz } from "./preis-parameter.ts";
import { PreiserhebungSession, type PreisRepo } from "./session.ts";
import type { PreisparameterRow } from "./preis-parameter.ts";

// --- In-Memory-Repo, zählt Reads (belegt read-only: keine Schreibmethode) ---
class FakeRepo implements PreisRepo {
  reads = 0;
  constructor(private rows: PreisparameterRow[]) {}
  async ladeDruckparameter(): Promise<PreisparameterRow[]> {
    this.reads++;
    return this.rows.map((r) => ({ ...r })); // Kopie: Aufrufer kann Quelle nicht mutieren
  }
}

// ---------------------------------------------------------------------------
// 1. Druck-Engine: deterministischer Referenzwert gegen PLATZHALTER_PARAMETER.

test("berechnePreis: Referenzkonfiguration A4/4c/16S/500/standard_75/standard", () => {
  const r = berechnePreis(
    { format: "A4", farbigkeit: "4c", papiersorte: "standard_75", seiten: 16, auflage: 500, versand: "standard" },
    PLATZHALTER_PARAMETER,
  );
  assert.equal(r.details.blaetterProExemplar, 4);
  assert.equal(r.details.klicksGesamt, 4000);
  assert.equal(r.druckkosten, 640); // 4000 × 0,16
  assert.equal(r.papierkosten, 24); // 2000 × 0,012
  assert.equal(r.druckNetto, 699); // 35 + 640 + 24
  assert.equal(r.provision, 34.95); // 699 × 5 %
  assert.equal(r.netto, 741.85); // 699 × 1,05 + 7,90
  assert.equal(r.ust, 51.93); // 7 %
  assert.equal(r.brutto, 793.78);
});

test("berechnePreis: validiert Seiten (Vielfaches von 4) und Auflage", () => {
  assert.throws(() =>
    berechnePreis(
      { format: "A4", farbigkeit: "4c", papiersorte: "standard_75", seiten: 15, auflage: 500, versand: "standard" },
      PLATZHALTER_PARAMETER,
    ),
  );
});

// ---------------------------------------------------------------------------
// 2. DMS-ROI-Engine: Standard-Docuware-Modell.

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test("computeRoi: Default-Eingaben liefern erwartete Kennzahlen", () => {
  const r = computeRoi(DMS_ROI_CONFIG.defaults, DMS_ROI_CONFIG);
  assert.equal(r.docsPerYear, 24000);
  near(r.hoursSavedPerYear, 1200); // 0,3-Koeffizient → binäre Rundungsreste
  near(r.breakdown.timeSavings, 54000);
  near(r.annualSavings, 60216);
  near(r.netAnnualBenefit, 48216);
  near(r.horizons[3].netGain, 104648);
});

test("computeRoi: kein Payback wenn laufende Kosten den Nutzen übersteigen", () => {
  const r = computeRoi({ ...DMS_ROI_CONFIG.defaults, licenseYearly: 999999 }, DMS_ROI_CONFIG);
  assert.equal(r.paybackMonths, null);
});

// ---------------------------------------------------------------------------
// 3. D1-Row-Mapping (read-only Quelle).

test("baueParametersatz: D1-Rows überschreiben Fallback, fehlende Keys bleiben", () => {
  const p = baueParametersatz([
    { schluessel: "klickpreis_4c", wert: 0.1 },
    { schluessel: "papierpreis_standard_75_A4", wert: 0.02 },
    { schluessel: "versandkosten_express", wert: 30 },
    { schluessel: "provisionRate", wert: 0.08 },
    { schluessel: "unbekannter_key", wert: 123 }, // ignoriert
  ]);
  assert.equal(p.klickpreis["4c"], 0.1);
  assert.equal(p.papierpreis["standard_75"].A4, 0.02);
  assert.equal(p.versandkosten.express, 30);
  assert.equal(p.provisionRate, 0.08);
  assert.equal(p.ruestkosten, 35); // Fallback unberührt
  assert.equal(p.klickpreis.sw, 0.03); // Fallback unberührt
});

// ---------------------------------------------------------------------------
// 4. Session + Vertriebs-Overrides (Quelle bleibt read-only unangetastet).

test("Session: Overrides ändern nur den Aufruf, nicht die D1-Quelle", async () => {
  const repo = new FakeRepo([{ schluessel: "provisionRate", wert: 0.05 }]);
  const session = new PreiserhebungSession(repo);

  const basis = await session.getDruckparameter();
  assert.equal(basis.provisionRate, 0.05);

  // Vertrieb rechnet "was wäre bei 12 % Provision?" durch
  const mitOverride = await session.getDruckparameter({ provisionRate: 0.12 });
  assert.equal(mitOverride.provisionRate, 0.12);

  // Erneuter Read ohne Override liefert wieder die Quelle → nichts persistiert
  const wieder = await session.getDruckparameter();
  assert.equal(wieder.provisionRate, 0.05);
  assert.equal(repo.reads, 3);
});

test("Session: berechneDruckPreis mit Override erhöht Provision & Endpreis", async () => {
  const repo = new FakeRepo([]); // reiner Fallback-Satz
  const session = new PreiserhebungSession(repo);
  const konfig = {
    format: "A4" as const, farbigkeit: "4c" as const, papiersorte: "standard_75",
    seiten: 16, auflage: 500, versand: "standard" as const,
  };
  const ohne = await session.berechneDruckPreis(konfig);
  const mit = await session.berechneDruckPreis(konfig, { provisionRate: 0.1 });
  assert.ok(mit.netto > ohne.netto);
  assert.equal(mit.provision, 69.9); // 699 × 10 %
});

test("Session: berechneDmsRoi mit Koeffizienten-Override", async () => {
  const repo = new FakeRepo([]);
  const session = new PreiserhebungSession(repo);
  const basis = await session.berechneDmsRoi(DMS_ROI_CONFIG.defaults);
  const mit = await session.berechneDmsRoi(DMS_ROI_CONFIG.defaults, {
    coeff: { searchTimeReductionPct: 0.5 },
  });
  assert.ok(mit.annualSavings < basis.annualSavings); // weniger Suchzeit-Ersparnis
});
