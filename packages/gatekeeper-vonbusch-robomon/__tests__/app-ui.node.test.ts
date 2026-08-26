/**
 * Headless-Verifikation der Robomon-Management-UI (VON-1842) — laeuft ohne Board/Browser:
 *   node --experimental-strip-types --test __tests__/app-ui.node.test.ts
 *
 * Prueft (1) dass der gebackene Snapshot als valides, escaptes HTML mit den Kern-Kennzahlen
 * herauskommt und (2) dass RobomonManagementApi read-only an eine In-Memory-HealthRepo delegiert.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RobomonSession, type HealthRepo } from "../src/session.ts";
import type { AuthmonState } from "../src/health.ts";
import { RobomonManagementApi, buildRobomonAppHtml } from "../src/app-ui.ts";

// Fixes "jetzt" fuer deterministische Ableitung (frischer Heartbeat, gesunde Quote).
const NOW = Date.UTC(2026, 7, 26, 6, 0, 0);

function makeRepo(state: AuthmonState): HealthRepo {
  return { ladeState: async () => state };
}

const healthyState: AuthmonState = {
  bootAt: NOW - 3 * 60 * 60 * 1000,
  hb: {
    receivedAt: NOW - 3 * 60 * 1000,
    host: "paperclip-host-01",
    today: { date: "2026-08-26", succeeded: 40, failed: 1, total: 41 },
    window: { succeeded: 12, failed: 0, total: 12 },
    tokenExpiresAt: NOW + 20 * 60 * 60 * 1000,
  },
  alarm: null,
};

test("buildRobomonAppHtml backt Snapshot als valides HTML", async () => {
  const session = new RobomonSession(makeRepo(healthyState), () => NOW);
  const snapshot = await session.getSnapshot();
  const activity = await session.getRunActivity();
  const html = buildRobomonAppHtml(snapshot, activity);

  assert.ok(html.startsWith("<!doctype html>"), "vollstaendiges HTML-Dokument");
  assert.match(html, /Content-Security-Policy/, "CSP gesetzt");
  assert.match(html, /default-src 'none'/, "netzisoliert");
  assert.match(html, /Robomon/, "Titel");
  assert.match(html, /paperclip-host-01/, "Host gebacken");
  assert.match(html, /40 ok/, "Runs heute gebacken");
  // Kein offenes Script-Tag mit Fremdinhalt: read-only Snapshot ist rein deklarativ.
  assert.ok(!/<script/i.test(html), "kein Skript im Frame");
});

test("HTML escaped gefaehrliche Werte", async () => {
  const evil: AuthmonState = {
    bootAt: NOW - 1000,
    hb: { receivedAt: NOW - 1000, host: "<img src=x onerror=alert(1)>", today: null, window: null, tokenExpiresAt: null },
    alarm: null,
  };
  const session = new RobomonSession(makeRepo(evil), () => NOW);
  const html = buildRobomonAppHtml(await session.getSnapshot(), await session.getRunActivity());
  assert.ok(!html.includes("<img src=x"), "Rohes Markup nicht eingebettet");
  assert.match(html, /&lt;img src=x/, "escaped");
});

test("RobomonManagementApi delegiert read-only an die Session", async () => {
  const session = new RobomonSession(makeRepo(healthyState), () => NOW);
  const api = new RobomonManagementApi(session);
  const snap = await api.getSnapshot();
  assert.equal(snap.level, "OK");
  assert.equal(snap.host, "paperclip-host-01");
  const line = await api.getHealthLine();
  assert.ok(typeof line === "string" && line.length > 0);
  const act = await api.getRunActivity();
  assert.equal(act.windowFailRatePct, 0);
  // Nur Reads exponiert — keine mutierende Methode.
  assert.equal(typeof (api as unknown as { applyAction?: unknown }).applyAction, "undefined");
});
