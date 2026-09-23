import { describe, expect, it } from "vitest";
import { shapeUnifiInventory, extractIspWan } from "../src/unifi-inventory";

// Raw shapes mirror the gatekeeper's untyped passthrough (types.txt): hosts have id/isbBlocked/
// reportedState; sites have siteId/hostId/meta; devices come grouped by host with a status string.

describe("shapeUnifiInventory", () => {
  it("rolls up device counts and derives an OK status for a healthy site", () => {
    const inv = shapeUnifiInventory(
      [{ id: "h1", isBlocked: false, reportedState: { hostname: "Console A" } }],
      [{ siteId: "s1", hostId: "h1", meta: { name: "HQ" } }],
      [{ hostId: "h1", devices: [{ status: "online" }, { status: "online" }] }],
    );
    expect(inv.connected).toBe(true);
    expect(inv.hostCount).toBe(1);
    expect(inv.sites).toHaveLength(1);
    const s = inv.sites[0];
    expect(s).toMatchObject({
      name: "HQ", hostName: "Console A", hostOnline: true,
      deviceTotal: 2, deviceOnline: 2, deviceOffline: 0, status: "ok",
    });
  });

  it("flags a warning when any device is offline", () => {
    const inv = shapeUnifiInventory(
      [{ id: "h1", isBlocked: false }],
      [{ siteId: "s1", hostId: "h1" }],
      [{ hostId: "h1", devices: [{ status: "online" }, { status: "offline" }] }],
    );
    expect(inv.sites[0]).toMatchObject({ deviceOnline: 1, deviceOffline: 1, status: "warning" });
  });

  it("marks a site offline when its host is unreachable, regardless of devices", () => {
    const inv = shapeUnifiInventory(
      [{ id: "h1", isBlocked: true }],
      [{ siteId: "s1", hostId: "h1" }],
      [{ hostId: "h1", devices: [{ status: "online" }] }],
    );
    expect(inv.sites[0]).toMatchObject({ hostOnline: false, status: "offline" });
  });

  it("falls back to desc then siteId for the display name, and tolerates missing host/devices", () => {
    const inv = shapeUnifiInventory(
      [],
      [{ siteId: "s1", hostId: "hX", meta: { desc: "Warehouse" } }, { siteId: "s2", hostId: "hY" }],
      [],
    );
    expect(inv.sites[0].name).toBe("Warehouse");
    expect(inv.sites[1].name).toBe("s2");
    // No host record + no devices => treated as reachable with zero devices, status ok.
    expect(inv.sites[1]).toMatchObject({ deviceTotal: 0, hostOnline: true, status: "ok" });
  });

  it("does not crash on null/garbage input", () => {
    expect(shapeUnifiInventory(null as any, null as any, null as any).sites).toEqual([]);
  });
});

describe("extractIspWan", () => {
  it("surfaces isp/wan-keyed strings from reportedState and nothing else", () => {
    expect(extractIspWan({ reportedState: { ispName: "ACME", wanStatus: "connected", cpu: 12 } }))
      .toEqual({ isp: "ACME", wan: "connected" });
  });

  it("returns empty when no isp/wan fields are present", () => {
    expect(extractIspWan({ reportedState: { hostname: "x" } })).toEqual({});
    expect(extractIspWan(undefined)).toEqual({});
  });
});
