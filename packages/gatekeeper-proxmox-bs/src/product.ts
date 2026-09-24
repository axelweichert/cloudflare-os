// Per-product constants for the Proxmox Backup Server gatekeeper. Its sibling gatekeeper-proxmox-ve
// (Proxmox Virtual Environment) has the same connect-flow / vendor / user / gatekeeper shape; the two
// packages differ only in this file, `vendor.ts`, the session read surface in `proxmox.ts`, the
// agent-facing `types.d.ts`, `package.json` and `wrangler.jsonc`. `proxmox-api.ts`, `token.ts` and
// the configurator are identical copies.
//
// Verified contract (OWL-1681, checked against the live tunnel 2026-09-24 with a token-free probe
// only — no token was ever spent, see the SEAM note in proxmox-api.ts):
//   - Base:        https://pbs.weichert.at/api2/json
//   - Auth header: Authorization: PBSAPIToken=USER@REALM!TOKENID=SECRET   (PBS prefix, NOT PVE)
//   - Verify:      GET /api2/json/version  (read-only) → { data: { version, release, ... } }
//   - Fallback:    GET /api2/json/admin/datastore
const HOST = "pbs.weichert.at";

export const PRODUCT = {
  /** GATEKEEPER_<suffix> binding suffix, lowercased (router maps `_`→`-` for the path). */
  vendorId: "proxmox_bs",
  displayName: "Proxmox Backup Server",
  fullName: "Proxmox Backup Server",
  homeUrl: "https://www.proxmox.com/en/products/proxmox-backup-server",
  tagline: "Connect your Proxmox Backup Server.",

  host: HOST,
  base: `https://${HOST}/api2/json`,
  /** PBS uses `PBSAPIToken`; PVE uses `PVEAPIToken`. Never mix them up. */
  authPrefix: "PBSAPIToken",

  /** Edge origin (never localhost). Router forwards /gatekeeper/proxmox-bs/* here (OWL-1600/1619). */
  basePath: "/gatekeeper/proxmox-bs",
  edgeBaseUrl: "https://cloudflareos.weichert.at/gatekeeper/proxmox-bs",

  /** Read-only verify call, plus a documented fallback if `/version` ever 404/501s. */
  verifyPath: "/version",
  verifyFallback: "/admin/datastore",

  suggestedBinding: "PROXMOX_BS",
  tsType: "ProxmoxBackupSession",
  resourceUrlPattern: `https://${HOST}/*`,
  themeColor: "#e57000", // Proxmox orange
} as const;
