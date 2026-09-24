// Per-product constants for the Proxmox VE gatekeeper. Its sibling gatekeeper-proxmox-bs (Proxmox
// Backup Server) has the same connect-flow / vendor / user / gatekeeper shape; the two packages
// differ only in this file, `vendor.ts`, the agent-facing `types.d.ts`, `package.json` and
// `wrangler.jsonc`. `proxmox.ts`, `proxmox-api.ts`, `token.ts` and the configurator are identical.
//
// Verified contract (OWL-1681, checked against the live tunnel 2026-09-24 with a token-free probe
// only — no token was ever spent, see the SEAM note in proxmox-api.ts):
//   - Base:        https://pve.weichert.at/api2/json
//   - Auth header: Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET
//   - Verify:      GET /api2/json/version  (read-only) → { data: { version, release, ... } }
//   - Fallback:    GET /api2/json/nodes
const HOST = "pve.weichert.at";

export const PRODUCT = {
  /** GATEKEEPER_<suffix> binding suffix, lowercased (router maps `_`→`-` for the path). */
  vendorId: "proxmox_ve",
  displayName: "Proxmox VE",
  fullName: "Proxmox Virtual Environment",
  homeUrl: "https://www.proxmox.com/en/products/proxmox-virtual-environment",
  tagline: "Connect your Proxmox Virtual Environment.",

  host: HOST,
  base: `https://${HOST}/api2/json`,
  /** PVE uses `PVEAPIToken`; PBS uses `PBSAPIToken`. Never mix them up. */
  authPrefix: "PVEAPIToken",

  /** Edge origin (never localhost). Router forwards /gatekeeper/proxmox-ve/* here (OWL-1600/1619). */
  basePath: "/gatekeeper/proxmox-ve",
  edgeBaseUrl: "https://cloudflareos.weichert.at/gatekeeper/proxmox-ve",

  /** Read-only verify call, plus a documented fallback if `/version` ever 404/501s. */
  verifyPath: "/version",
  verifyFallback: "/nodes",

  suggestedBinding: "PROXMOX_VE",
  tsType: "ProxmoxVeSession",
  resourceUrlPattern: `https://${HOST}/*`,
  themeColor: "#e57000", // Proxmox orange

  // Read surface exposed to agents after connect (read-only S1). `overview` is the one product-
  // specific read; VE lists cluster nodes, PBS reports datastore usage.
  overviewPath: "/nodes",
  overviewTitle: "List Proxmox VE nodes",
  overviewObservation: "Listed the cluster's nodes (`GET /api2/json/nodes`).",
} as const;
