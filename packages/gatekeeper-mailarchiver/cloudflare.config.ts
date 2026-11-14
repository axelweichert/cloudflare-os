import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-mailarchiver",
  entrypoint: ".wrangler/validate/src/mailarchiver.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  env: {
    BASE_URL: bindings.text("https://cloudflareos.weichert.at/gatekeeper/mailarchiver"),
  },
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "MailArchiverGatekeeperImpl"] },
];
