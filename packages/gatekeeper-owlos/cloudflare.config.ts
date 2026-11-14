import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-owlos",
  entrypoint: ".wrangler/validate/src/owlos.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  env: {
    BASE_URL: bindings.text("https://cloudflareos.weichert.at/gatekeeper/owlos"),
  },
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "OwlosGatekeeperImpl"] },
];
