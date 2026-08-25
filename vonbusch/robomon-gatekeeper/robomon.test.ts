// vonBuschOS — Robomon-Gatekeeper Tests (VON-1803 / K6)
//
// Workerd-frei, kostenfrei:  npx tsx --test vonbusch/robomon-gatekeeper/robomon.test.ts
//
// Deckt die Klassifikations-Branches (konsistent mit von-authmon `evaluate`), die
// read-only Session-Oberfläche und den MCP-Server (read-only Tools) ab.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveHealth, healthLine, STALE_MS, type AuthmonState } from "./health.ts";
import { RobomonSession, type HealthRepo } from "./session.ts";
import { handleMcpMessage } from "./mcp-server.ts";

const T0 = 1_756_000_000_000; // fixe Basiszeit (ms) — kein Date.now() in Tests

/** In-Memory-Repo, das einen festen KV-Zustand zurückgibt. */
function repo(state: AuthmonState): HealthRepo {
  return { async ladeState() { return state; } };
}

function hbAt(receivedAt: number, extra: Record<string, unknown> = {}) {
  return { receivedAt, host: "paperclip-host", ...extra };
}

test("BOOTING: kein Heartbeat innerhalb der Grace-Period → OK/BOOTING", () => {
  const snap = deriveHealth(T0 + 5 * 60_000, { bootAt: T0, hb: null, alarm: null });
  assert.equal(snap.level, "OK");
  assert.equal(snap.kind, "BOOTING");
  assert.equal(snap.heartbeatAgeMinutes, null);
  assert.equal(snap.heartbeatFresh, false);
});

test("NO_HEARTBEAT: nie ein Heartbeat jenseits STALE → ALARM (Dead-Man)", () => {
  const snap = deriveHealth(T0 + STALE_MS + 60_000, { bootAt: T0, hb: null, alarm: null });
  assert.equal(snap.level, "ALARM");
  assert.equal(snap.kind, "NO_HEARTBEAT");
});

test("STALE_HEARTBEAT: alter Heartbeat jenseits STALE → ALARM", () => {
  const state: AuthmonState = { bootAt: T0, hb: hbAt(T0), alarm: null };
  const snap = deriveHealth(T0 + STALE_MS + 120_000, state);
  assert.equal(snap.level, "ALARM");
  assert.equal(snap.kind, "STALE_HEARTBEAT");
  assert.equal(snap.heartbeatFresh, false);
  assert.ok(snap.heartbeatAgeMinutes! >= 45);
});

test("HEALTHY: frischer Heartbeat, sauberes Fenster → OK/HEALTHY", () => {
  const state: AuthmonState = {
    bootAt: T0,
    hb: hbAt(T0, {
      today: { date: "2026-08-25", succeeded: 40, failed: 1, total: 41 },
      window: { succeeded: 6, failed: 0, total: 6 },
    }),
    alarm: null,
  };
  const snap = deriveHealth(T0 + 60_000, state);
  assert.equal(snap.level, "OK");
  assert.equal(snap.kind, "HEALTHY");
  assert.equal(snap.heartbeatFresh, true);
  assert.match(snap.detail, /Heute 2026-08-25/);
});

test("ZERO_SUCCESS: Fenster mit Fehlern und 0 Erfolgen (>=3) → ALARM", () => {
  const state: AuthmonState = {
    bootAt: T0,
    hb: hbAt(T0, {
      today: { date: "2026-08-25", succeeded: 10, failed: 4, total: 14 },
      window: { succeeded: 0, failed: 4, total: 4 },
    }),
    alarm: { kind: "ZERO_SUCCESS", level: "ALARM", since: T0 },
  };
  const snap = deriveHealth(T0 + 60_000, state);
  assert.equal(snap.level, "ALARM");
  assert.equal(snap.kind, "ZERO_SUCCESS");
  // Der persistierte Alarm wird mitgeführt.
  assert.equal(snap.authmonAlarm?.kind, "ZERO_SUCCESS");
});

test("HIGH_FAILRATE: Fehlerquote >=25% bei >=5 Runs → ALARM", () => {
  const state: AuthmonState = {
    bootAt: T0,
    hb: hbAt(T0, {
      today: { date: "2026-08-25", succeeded: 20, failed: 5, total: 25 },
      window: { succeeded: 6, failed: 2, total: 8 }, // 25%
    }),
    alarm: null,
  };
  const snap = deriveHealth(T0 + 60_000, state);
  assert.equal(snap.level, "ALARM");
  assert.equal(snap.kind, "HIGH_FAILRATE");
});

test("Fenster unter MIN_TOTAL_FOR_RATE alarmiert NICHT auf Quote", () => {
  const state: AuthmonState = {
    bootAt: T0,
    hb: hbAt(T0, {
      today: { date: "2026-08-25", succeeded: 2, failed: 2, total: 4 },
      window: { succeeded: 2, failed: 2, total: 4 }, // 50% aber nur 4 Runs, 2 Erfolge
    }),
    alarm: null,
  };
  const snap = deriveHealth(T0 + 60_000, state);
  assert.equal(snap.level, "OK");
  assert.equal(snap.kind, "HEALTHY");
});

test("Token: Near-Expiry ist informativ, kein Alarm; abgelaufen ebenso", () => {
  const near = deriveHealth(T0 + 60_000, {
    bootAt: T0,
    hb: hbAt(T0, { today: { date: "2026-08-25", succeeded: 5, failed: 0, total: 5 }, tokenExpiresAt: T0 + 90 * 60_000 }),
    alarm: null,
  });
  assert.equal(near.level, "OK");
  assert.equal(near.token?.expired, false);
  assert.ok(near.token!.expiresInHours > 1 && near.token!.expiresInHours < 2);
  assert.match(near.detail, /Token: läuft in/);

  const expired = deriveHealth(T0 + 60_000, {
    bootAt: T0,
    hb: hbAt(T0, { today: { date: "2026-08-25", succeeded: 5, failed: 0, total: 5 }, tokenExpiresAt: T0 - 60_000 }),
    alarm: null,
  });
  assert.equal(expired.level, "OK", "abgelaufener Token allein ist kein Alarm (VON-1775)");
  assert.equal(expired.token?.expired, true);
});

test("healthLine: kompakte Ampel-Zeile", () => {
  const okLine = healthLine(deriveHealth(T0 + 60_000, {
    bootAt: T0,
    hb: hbAt(T0, { today: { date: "2026-08-25", succeeded: 5, failed: 0, total: 5 }, window: { succeeded: 5, failed: 0, total: 5 } }),
    alarm: null,
  }));
  assert.match(okLine, /^🟢 HEALTHY · hb 1m/);

  const alarmLine = healthLine(deriveHealth(T0 + STALE_MS + 60_000, { bootAt: T0, hb: hbAt(T0), alarm: null }));
  assert.match(alarmLine, /^🔴 STALE_HEARTBEAT/);
});

test("Session: alle Methoden sind reine Reads und liefern konsistente Daten", async () => {
  const state: AuthmonState = {
    bootAt: T0,
    hb: hbAt(T0, {
      today: { date: "2026-08-25", succeeded: 20, failed: 5, total: 25 },
      window: { succeeded: 6, failed: 2, total: 8 },
      tokenExpiresAt: T0 + 5 * 3600_000,
    }),
    alarm: { kind: "HIGH_FAILRATE", level: "ALARM", since: T0 - 60_000 },
  };
  const session = new RobomonSession(repo(state), () => T0 + 60_000);

  const snap = await session.getSnapshot();
  assert.equal(snap.kind, "HIGH_FAILRATE");

  const runs = await session.getRunActivity();
  assert.equal(runs.windowFailRatePct, 25);
  assert.equal(runs.today?.total, 25);

  const token = await session.getTokenStatus();
  assert.equal(token?.expired, false);

  const alarm = await session.getActiveAlarm();
  assert.equal(alarm.persisted?.kind, "HIGH_FAILRATE");
  assert.equal(alarm.derivedLevel, "ALARM");

  const line = await session.getHealthLine();
  assert.match(line, /^🔴 HIGH_FAILRATE/);
});

test("Session: leere KV (Kaltstart) → BOOTING ohne Fehler", async () => {
  const session = new RobomonSession(repo({ bootAt: null, hb: null, alarm: null }), () => T0);
  const snap = await session.getSnapshot();
  assert.equal(snap.kind, "BOOTING");
  const runs = await session.getRunActivity();
  assert.equal(runs.windowFailRatePct, null);
  assert.equal(await session.getTokenStatus(), null);
});

test("MCP: tools/list liefert genau 4 read-only Tools mit readOnlyHint", async () => {
  const session = new RobomonSession(repo({ bootAt: T0, hb: hbAt(T0), alarm: null }), () => T0 + 60_000);
  const res = await handleMcpMessage({ session }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = (res as any).result.tools as any[];
  assert.equal(tools.length, 4);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} muss readOnlyHint:true tragen`);
  }
});

test("MCP: tools/call get_health liefert JSON-Content", async () => {
  const state: AuthmonState = {
    bootAt: T0,
    hb: hbAt(T0, { today: { date: "2026-08-25", succeeded: 5, failed: 0, total: 5 } }),
    alarm: null,
  };
  const session = new RobomonSession(repo(state), () => T0 + 60_000);
  const res = await handleMcpMessage(
    { session },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_health", arguments: {} } },
  );
  const text = (res as any).result.content[0].text as string;
  const parsed = JSON.parse(text);
  assert.equal(parsed.kind, "HEALTHY");
  assert.equal(parsed.level, "OK");
});

test("MCP: unbekanntes Tool → JSON-RPC-Fehler (-32602)", async () => {
  const session = new RobomonSession(repo({ bootAt: T0, hb: hbAt(T0), alarm: null }), () => T0 + 60_000);
  const res = await handleMcpMessage(
    { session },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delete_everything", arguments: {} } },
  );
  assert.equal((res as any).error.code, -32602);
});
