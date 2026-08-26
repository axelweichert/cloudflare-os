// Preiserhebungs-Gatekeeper Board-UI (VON-1846) — workerd-freier Test der App-UI-Schicht.
//
// Lauf:  node --import tsx --test __tests__/app-ui.test.ts
//
// Belegt, dass der read-only Erst-Render-Snapshot serverseitig aus der (read-only) Session
// gebacken wird und das iframe-HTML skriptfrei ist (default-src 'none'), die Referenzwerte
// (Druck-Brutto 793,78 €) enthaelt und die `ui`-Capability 1:1 an die Session delegiert. Die
// Vendor/DO-RPC-Huelle (startAppUi in gadget.ts) verlangt echtes workerd und wird ueber den
// `wrangler deploy --dry-run` (Build) sowie `tsc` (Typen) mitgeprueft.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PreiserhebungSession, type PreisRepo } from "../src/session.ts";
import type { PreisparameterRow } from "../src/preis-parameter.ts";
import {
  buildPreiserhebungAppHtml,
  ladePreiserhebungSnapshot,
  PreiserhebungManagementApi,
  REFERENZ_KONFIGURATION,
} from "../src/app-ui.ts";

// In-Memory-Repo (leer → PLATZHALTER_PARAMETER-Fallback), zaehlt Reads: belegt read-only.
class FakeRepo implements PreisRepo {
  reads = 0;
  constructor(private rows: PreisparameterRow[] = []) {}
  async ladeDruckparameter(): Promise<PreisparameterRow[]> {
    this.reads++;
    return this.rows.map((r) => ({ ...r }));
  }
}

function newSession(rows: PreisparameterRow[] = []) {
  const repo = new FakeRepo(rows);
  return { repo, session: new PreiserhebungSession(repo) };
}

test("ladePreiserhebungSnapshot liest nur (read-only) und liefert Referenzwerte", async () => {
  const { repo, session } = newSession();
  const snap = await ladePreiserhebungSnapshot(session);

  // Referenz-Broschuere = A4/4c/16S/500/standard_75/standard → Brutto 793,78 € (VON-1801-Kalibrierung).
  assert.equal(snap.referenzKonfiguration.format, "A4");
  assert.equal(snap.referenzKonfiguration.seiten, 16);
  assert.equal(snap.referenzPreis.brutto, 793.78);
  assert.ok(snap.roi.netAnnualBenefit > 0, "DMS-ROI-Nettonutzen positiv");
  assert.ok(Object.keys(snap.roi.horizons).length > 0, "mindestens ein ROI-Horizont");
  assert.ok(repo.reads >= 1, "es wurde gelesen");
});

test("buildPreiserhebungAppHtml ist skriptfrei und enthaelt die Kernwerte", async () => {
  const { session } = newSession();
  const html = buildPreiserhebungAppHtml(await ladePreiserhebungSnapshot(session));

  // Skriptfrei / gesperrt (CSP default-src none, kein <script>).
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!/<script/i.test(html), "kein Skript im Frame");

  // Kernwerte gebacken.
  assert.ok(html.includes("793,78"), "Referenz-Brutto sichtbar");
  assert.ok(html.includes("Preisparameter"), "Parametersatz-Abschnitt");
  assert.ok(html.includes("DMS-ROI"), "ROI-Abschnitt");
  assert.ok(html.includes("standard_75"), "Referenzkonfiguration sichtbar");
});

test("HTML escaped potentiell gefaehrliche Papiersorten-Namen", async () => {
  const { session } = newSession();
  const snap = await ladePreiserhebungSnapshot(session);
  // Snapshot-Konfiguration manipulieren, um den Escaping-Pfad zu treffen.
  const bad = { ...snap, referenzKonfiguration: { ...snap.referenzKonfiguration, papiersorte: '<img src=x>' } };
  const html = buildPreiserhebungAppHtml(bad);
  assert.ok(!html.includes("<img src=x>"), "roher HTML-Tag darf nicht durchschlagen");
  assert.ok(html.includes("&lt;img src=x&gt;"), "escaped statt roh");
});

test("PreiserhebungManagementApi delegiert read-only 1:1 an die Session", async () => {
  const { repo, session } = newSession();
  const api = new PreiserhebungManagementApi(session);

  const preis = await api.berechneDruckPreis(REFERENZ_KONFIGURATION);
  assert.equal(preis.brutto, 793.78);
  const params = await api.getDruckparameter();
  assert.ok(params.ust > 0);
  assert.ok(repo.reads >= 2, "Delegation hat gelesen");

  // Keine Schreibmethode an der UI-Capability.
  assert.equal(typeof (api as unknown as { applyAction?: unknown }).applyAction, "undefined");
});
