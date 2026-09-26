// TypeScript interface for the UniFi gatekeeper. These types are exposed to gadgets and agents
// that have been granted access to a UniFi Site Manager account.
//
// UniFi Site Manager is Ubiquiti's cloud control plane (https://unifi.ui.com). Through a single
// account API key it offers a read-only, account-wide view of every UniFi console (host) the key
// can see, the sites configured on them, and the devices adopted into those sites.
//
// This gatekeeper is READ-ONLY. It never changes any UniFi configuration or device state; it only
// reads inventory. Every read is authorized as an observation before any data is returned.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
//
// 1. **All methods take POSITIONAL arguments. Never pass a single options object.**
// 2. All methods are async and must be awaited.
// 3. IDs are opaque strings assigned by UniFi; pass them back verbatim.
// 4. Shapes below capture the fields you will most often use. UniFi returns additional fields;
//    they are preserved on the returned objects even though they are not all typed here.

/** A UniFi console (a Dream Machine, Cloud Gateway, CloudKey, etc.) visible to the account. */
export interface UnifiHost {
  /** Opaque host id. Pass to `getHost` / `listDevices`. */
  id: string;
  /** Hardware/console name as shown in Site Manager. */
  hostname?: string;
  /** True if this console is currently reachable by the cloud. */
  isBlocked?: boolean;
  /** Owner / access role of the current key on this host (e.g. "owner", "admin"). */
  userData?: unknown;
  /** Reported controller/firmware and hardware details. */
  reportedState?: {
    hostname?: string;
    name?: string;
    hardware?: { name?: string; shortname?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** A UniFi site: a logical grouping of devices within a host. */
export interface UnifiSite {
  /** Opaque site id. */
  siteId: string;
  /** The host this site belongs to. */
  hostId: string;
  /** Human-readable site name / description. */
  meta?: { name?: string; desc?: string; timezone?: string; [k: string]: unknown };
  /** Roll-up counts UniFi attaches to a site (device totals, adoption state, etc.). */
  statistics?: {
    counts?: Record<string, number>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** An adopted UniFi device (access point, switch, gateway, camera, …). */
export interface UnifiDevice {
  /** Device MAC — the stable identifier UniFi uses. */
  mac?: string;
  /** Device model name. */
  name?: string;
  /** Model code (e.g. "U6-Pro"). */
  model?: string;
  /** Product line (e.g. "network", "protect"). */
  productLine?: string;
  /** Current adoption / connection status. */
  status?: string;
  /** Firmware version currently running. */
  version?: string;
  /** IP address on the local network, when reported. */
  ip?: string;
  [k: string]: unknown;
}

/** Devices grouped under one host, as the Site Manager API returns them. */
export interface UnifiHostDevices {
  /** The host these devices belong to. */
  hostId: string;
  /** The host's name, echoed for convenience. */
  hostName?: string;
  /** The adopted devices on this host. */
  devices: UnifiDevice[];
  [k: string]: unknown;
}

/**
 * Whole-account, read-only access to a UniFi Site Manager account.
 *
 * This is the session interface a gadget receives when granted the "UniFi Account" resource.
 */
export interface UnifiSession {
  /** List every console (host) the account can see. */
  listHosts(): Promise<UnifiHost[]>;

  /** Get one console's full detail by id. */
  getHost(hostId: string): Promise<UnifiHost>;

  /** List every site across all consoles. */
  listSites(): Promise<UnifiSite[]>;

  /**
   * List adopted devices, grouped by host. Pass a `hostId` to restrict to a single console, or
   * omit it to list devices across every console the account can see.
   */
  listDevices(hostId?: string): Promise<UnifiHostDevices[]>;
}
