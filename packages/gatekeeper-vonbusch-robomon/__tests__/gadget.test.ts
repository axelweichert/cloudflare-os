/**
 * Workerd-Gadget-Test des Robomon-Ports (VON-1814). Läuft in echtem workerd (vitest-pool-workers)
 * und fährt den kompletten GatekeeperVendor→Account→DO-Session-Fluss über `TestControl` (das
 * ctx.exports serverseitig nutzt). Belegt für den Referenz-Port:
 *   - Vendor ist auto-provisioniert (Kachel erscheint ohne OAuth), Typen enthalten RobomonHealth
 *   - Account ist der Singleton `RobomonHealth`, DO hat keine auto-approvable Actions
 *   - alle vier Observations laufen durch authorizeObservation() und liefern die KV-Ableitung
 *   - ein ablehnender Authorizer blockiert jede Beobachtung (kein Datenrückfluss)
 */

import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";

const NOW_ISH = 1_735_000_000_000;

// Seedet die von-authmon-KV mit einem HIGH_FAILRATE-Zustand + offenem Alarm, frischer Heartbeat.
async function seedAuthmonKv(): Promise<void> {
  await env.AUTHMON_KV.put("bootAt", String(NOW_ISH - 3_600_000));
  await env.AUTHMON_KV.put(
    "hb",
    JSON.stringify({
      receivedAt: Date.now() - 120_000, // frisch (< 45 min)
      today: { date: "2025-12-24", succeeded: 10, failed: 6, total: 16 },
      window: { succeeded: 4, failed: 4, total: 8 }, // 50% Fehlerquote → HIGH_FAILRATE
      tokenExpiresAt: Date.now() + 5 * 3_600_000,
      host: "host-a",
    }),
  );
  await env.AUTHMON_KV.put(
    "alarm",
    JSON.stringify({ kind: "HIGH_FAILRATE", level: "ALARM", since: Date.now() - 600_000 }),
  );
}

beforeEach(async () => {
  await seedAuthmonKv();
});

it("provisioniert Vendor + Singleton-Account und exponiert RobomonHealth-Typen", async () => {
  const r = await env.TEST_CONTROL.run();
  expect(r.vendor.displayName).toBe("Robomon");
  expect(r.vendor.autoProvisionsAccount).toBe(true);
  expect(r.vendor.providesAuth).toBe(false);
  expect(r.supportedResourcesEmpty).toBe(true);
  expect(r.typesHasRobomonHealth).toBe(true);
  expect(r.account.singletonTsType).toBe("RobomonHealth");
  expect(r.resource.tsType).toBe("RobomonHealth");
  expect(r.resource.suggestedBindingName).toBe("ROBOMON");
});

it("read-only: keine auto-approvable Actions", async () => {
  const r = await env.TEST_CONTROL.run();
  expect(r.autoApprovable).toEqual([]);
});

it("alle vier Observations sind gated und spiegeln die KV-Ableitung", async () => {
  const r = await env.TEST_CONTROL.run();
  // Ableitung aus dem geseedeten Zustand.
  expect(r.observed.kind).toBe("HIGH_FAILRATE");
  expect(r.observed.level).toBe("ALARM");
  expect(r.observed.failRatePct).toBe(50);
  expect(r.observed.alarmKind).toBe("HIGH_FAILRATE");
  // Fünf Reads (health, run, alarm, token, line) → fünf authorizeObservation-Aufrufe.
  expect(r.observationTitles.length).toBe(5);
  expect(r.observationTitles.some((t) => t.includes("HIGH_FAILRATE"))).toBe(true);
});

it("ablehnender Authorizer blockiert die Beobachtung", async () => {
  const r = await env.TEST_CONTROL.run();
  expect(r.rejectBlocked).toBe(true);
  // Die abgelehnte Read hat den Authorizer erreicht (Gate lief), gab aber keine Daten zurück.
  expect(r.rejectedTitles.length).toBe(1);
});
