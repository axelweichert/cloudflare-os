import type { UnifiInventory, UnifiSiteView } from "@gadgets/workshop-shared/api";

// Pure shaping helpers for the /unifi dashboard read (see UserDurableObject.getUnifiInventory).
// Kept out of user.ts so they can be unit-tested without pulling in the Durable Object runtime.
// All inputs are the gatekeeper's untyped passthrough objects, so everything is defensive.

// Best-effort WAN/ISP extraction. UniFi exposes these as untyped passthrough fields whose exact
// names vary by console model, so scan the host's reportedState for the first string whose KEY
// names an isp/wan value rather than hard-coding an unverified path.
// ponytail: pin the exact key(s) once verified against live Site-Manager JSON (OWL-1613 DoD #2).
export function extractIspWan(host: any): { isp?: string; wan?: string } {
  let out: { isp?: string; wan?: string } = {};
  let rs = host?.reportedState;
  if (rs && typeof rs === "object") {
    for (let [k, v] of Object.entries(rs)) {
      if (typeof v !== "string" || !v) continue;
      let key = k.toLowerCase();
      if (!out.isp && key.includes("isp")) out.isp = v;
      if (!out.wan && key.includes("wan")) out.wan = v;
    }
  }
  return out;
}

// Flatten the raw hosts/sites/device-groups into the UI-friendly inventory. Devices are grouped by
// host (cloud API scopes them per console, not per site), so a site inherits its host's device
// roll-up and reachability — accurate for the common one-site-per-console setup.
export function shapeUnifiInventory(
    hosts: any[], sites: any[], deviceGroups: any[]): UnifiInventory {
  let byHost = new Map<string, { total: number; online: number; offline: number }>();
  for (let group of deviceGroups ?? []) {
    let hostId = group?.hostId;
    if (!hostId) continue;
    let acc = byHost.get(hostId) ?? { total: 0, online: 0, offline: 0 };
    for (let d of Array.isArray(group?.devices) ? group.devices : []) {
      acc.total++;
      if (String(d?.status ?? "").toLowerCase() === "online") acc.online++;
      else acc.offline++;
    }
    byHost.set(hostId, acc);
  }

  let hostById = new Map<string, any>();
  for (let h of hosts ?? []) if (h?.id) hostById.set(h.id, h);

  let views: UnifiSiteView[] = (sites ?? []).map((site): UnifiSiteView => {
    let host = hostById.get(site?.hostId);
    let hostOnline = host ? host.isBlocked !== true : true;
    let counts = byHost.get(site?.hostId) ?? { total: 0, online: 0, offline: 0 };
    let { isp, wan } = extractIspWan(host);
    let status: UnifiSiteView["status"] =
        !hostOnline ? "offline" : counts.offline > 0 ? "warning" : "ok";
    return {
      siteId: String(site?.siteId ?? ""),
      hostId: String(site?.hostId ?? ""),
      name: site?.meta?.name || site?.meta?.desc || String(site?.siteId ?? "UniFi Site"),
      hostName: host?.reportedState?.hostname || host?.hostname,
      hostOnline,
      deviceTotal: counts.total,
      deviceOnline: counts.online,
      deviceOffline: counts.offline,
      status,
      isp,
      wan,
    };
  });

  return { connected: true, hostCount: (hosts ?? []).length, sites: views };
}
