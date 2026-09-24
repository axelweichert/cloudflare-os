// TypeScript interface for the Proxmox Backup Server (PBS) gatekeeper. Exposed to gadgets/agents
// granted read-only access to the connected PBS host.
//
// Connect is Token-Connect: the host is fixed (pbs.weichert.at) and the board pastes a PBS API token
// ("USER@REALM!TOKENID=SECRET"). The API lives under {host}/api2/json and every call is authenticated
// with `Authorization: PBSAPIToken=<token>`.
//
// SCOPE: read-only. Only the two endpoints verified in OWL-1681 are exposed — no guessed paths.

/** API version + build of the PBS host (`GET /api2/json/version`). */
export interface ProxmoxBsVersion {
  version?: string;
  release?: string;
  repoid?: string;
  [k: string]: unknown;
}

/** One datastore's usage figures (`GET /api2/json/status/datastore-usage`). */
export interface ProxmoxBsDatastoreUsage {
  store?: string;
  total?: number;
  used?: number;
  avail?: number;
  [k: string]: unknown;
}

/** Whole-host, read-only access to a Proxmox Backup Server host. */
export interface ProxmoxBsSession {
  /** API version and build of the connected host (`GET /api2/json/version`). */
  version(): Promise<ProxmoxBsVersion>;

  /** Usage figures per datastore (`GET /api2/json/status/datastore-usage`). */
  datastoreUsage(): Promise<ProxmoxBsDatastoreUsage[]>;
}
