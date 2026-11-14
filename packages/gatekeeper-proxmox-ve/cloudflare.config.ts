import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * Secrets, set per deployment and not declared here: PROXMOX_CF_ACCESS_CLIENT_ID and
 * PROXMOX_CF_ACCESS_CLIENT_SECRET, the deployment-wide Cloudflare Access service token used when a
 * connection did not enter its own (see proxmox-api.ts).
 */
export default defineGadgetsWorker({
  name: "gatekeeper-proxmox-ve",
  entrypoint: ".wrangler/validate/src/proxmox.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  env: {
    BASE_URL: bindings.text("https://cloudflareos.weichert.at/gatekeeper/proxmox-ve"),
  },
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "ProxmoxGatekeeperImpl"] },
];
