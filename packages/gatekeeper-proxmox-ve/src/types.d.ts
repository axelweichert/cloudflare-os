// TypeScript interface for the Proxmox VE gatekeeper. These types are exposed to gadgets and agents
// granted read-only access to a Proxmox Virtual Environment host.
//
// Proxmox VE (https://www.proxmox.com/en/products/proxmox-virtual-environment) is an open-source
// virtualization platform. This gatekeeper reaches one PVE host over its REST API (`/api2/json`)
// using a whole-host API token, and exposes a READ-ONLY inventory: the API version, the cluster's
// nodes, the QEMU virtual machines and LXC containers on each node, and per-node status.
//
// This gatekeeper NEVER starts, stops, creates, or modifies anything. Every read is authorized as an
// observation before any data is returned.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
//
// 1. **All methods take POSITIONAL arguments. Never pass a single options object.**
// 2. All methods are async and must be awaited.
// 3. `node` is a Proxmox node name (the `node` field from `listNodes()`); pass it back verbatim.
// 4. Shapes below capture the fields you will most often use. Proxmox returns additional fields;
//    they are preserved on the returned objects even though not all are typed here.

/** API version and build of the connected Proxmox VE host. */
export interface ProxmoxVeVersion {
  /** Human-readable version, e.g. "8.2.2". */
  version?: string;
  /** Release train, e.g. "8.2". */
  release?: string;
  /** Package repository id / build hash. */
  repoid?: string;
  [k: string]: unknown;
}

/** One node in the Proxmox VE cluster (a single host runs a one-node "cluster"). */
export interface ProxmoxVeNode {
  /** Node name — the identifier you pass to the per-node methods. */
  node: string;
  /** "online" / "offline". */
  status?: string;
  /** Fraction of CPU in use (0..1). */
  cpu?: number;
  /** Total logical CPUs. */
  maxcpu?: number;
  /** Memory used, in bytes. */
  mem?: number;
  /** Memory total, in bytes. */
  maxmem?: number;
  /** Uptime in seconds. */
  uptime?: number;
  [k: string]: unknown;
}

/** A QEMU virtual machine on a node. */
export interface ProxmoxVeVm {
  /** Numeric VM id. */
  vmid: number;
  /** VM name, when set. */
  name?: string;
  /** "running" / "stopped" / "paused". */
  status?: string;
  /** Assigned virtual CPUs. */
  cpus?: number;
  /** Configured memory, in bytes. */
  maxmem?: number;
  /** Configured primary disk size, in bytes. */
  maxdisk?: number;
  /** Uptime in seconds while running. */
  uptime?: number;
  [k: string]: unknown;
}

/** An LXC container on a node. */
export interface ProxmoxVeContainer {
  /** Numeric container id. */
  vmid: number;
  /** Container name / hostname, when set. */
  name?: string;
  /** "running" / "stopped". */
  status?: string;
  /** Assigned CPUs. */
  cpus?: number;
  /** Configured memory, in bytes. */
  maxmem?: number;
  /** Uptime in seconds while running. */
  uptime?: number;
  [k: string]: unknown;
}

/** Live status of a single node. */
export interface ProxmoxVeNodeStatus {
  /** Uptime in seconds. */
  uptime?: number;
  /** Load averages [1m, 5m, 15m], as strings from Proxmox. */
  loadavg?: string[];
  /** CPU usage fraction (0..1). */
  cpu?: number;
  /** Memory usage, in bytes. */
  memory?: { total?: number; used?: number; free?: number; [k: string]: unknown };
  /** Root filesystem usage, in bytes. */
  rootfs?: { total?: number; used?: number; free?: number; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Whole-host, read-only access to a Proxmox Virtual Environment host.
 *
 * This is the session interface a gadget receives when granted the "Proxmox VE" resource.
 */
export interface ProxmoxVeSession {
  /** API version and build of the connected host. */
  version(): Promise<ProxmoxVeVersion>;

  /** List the cluster's nodes (a single host reports one node). */
  listNodes(): Promise<ProxmoxVeNode[]>;

  /** List the QEMU virtual machines on `node`, with their current status. */
  listQemuVms(node: string): Promise<ProxmoxVeVm[]>;

  /** List the LXC containers on `node`, with their current status. */
  listContainers(node: string): Promise<ProxmoxVeContainer[]>;

  /** Read live status (uptime, CPU, memory, load) for `node`. */
  getNodeStatus(node: string): Promise<ProxmoxVeNodeStatus>;
}
