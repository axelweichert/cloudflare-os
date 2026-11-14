import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-vonbusch-robomon",
  entrypoint: ".wrangler/validate/src/robomon.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  env: {
    // Public origin of the router this gatekeeper is mounted under. Without it the connect link
    // falls back to http://localhost:8787.
    BASE_URL: bindings.text("https://cloudflareos.weichert.at/gatekeeper/vonbusch-robomon"),
  },
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

/**
 * Tags must stay identical to what is deployed.
 */
export const migrations: DurableObjectMigration[] = [
  // The live worker (cloudflareos-gk-robomon) is at tag v0 and already holds the classes
  // UserAccount (with stored connections) and RoboMonGatekeeperImpl; the old scaffold class
  // RobomonGatekeeper never exists there. So v0 is the only migration: it applies nothing on
  // the live worker and creates the right classes on a fresh install (OWL-2477).
  { tag: "v0", new_sqlite_classes: ["UserAccount", "RoboMonGatekeeperImpl"] },
];
