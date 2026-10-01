import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
]);

// Hermetic gatekeeper vendors used only by gatekeeper-vendor-isolation.test.ts (OWL-1752). They
// exercise the per-vendor isolation in listGatekeeperVendors without pulling in a real gatekeeper
// worker: one healthy, one that throws on describe(), one that resolves with structurally-broken
// data. The reply must still list the healthy vendor and downgrade the bad ones to `unavailable`
// tiles rather than rejecting the whole call.
const HEALTHY_VENDOR = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class GatekeeperVendor extends WorkerEntrypoint {
  async describe() { return { displayName: "Healthy", url: "https://healthy.example" }; }
  async getSupportedResources() {
    return [{ urlPattern: "https://healthy.example/*", title: "Thing", description: "A thing." }];
  }
  async getTypeScriptTypes() { return ""; }
}
export default { fetch() { return new Response("ok"); } };
`;
const THROWING_VENDOR = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class GatekeeperVendor extends WorkerEntrypoint {
  async describe() { throw new Error("vendor worker boot failure (simulated)"); }
  async getSupportedResources() { throw new Error("vendor worker boot failure (simulated)"); }
  async getTypeScriptTypes() { return ""; }
}
export default { fetch() { return new Response("throwing"); } };
`;
const MALFORMED_VENDOR = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class GatekeeperVendor extends WorkerEntrypoint {
  // Resolves (does not throw) with a VendorDescription that violates the schema: displayName is a
  // number and url is missing. Pre-OWL-1752 this was forwarded verbatim into the shared reply array.
  async describe() { return { displayName: 123 }; }
  async getSupportedResources() {
    return [{ urlPattern: "https://malformed.example/*", title: "T", description: "d" }];
  }
  async getTypeScriptTypes() { return ""; }
}
export default { fetch() { return new Response("malformed"); } };
`;

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        serviceBindings: {
          GATEKEEPER_HEALTHYVENDOR: { name: "healthy-vendor", entrypoint: "GatekeeperVendor" },
          GATEKEEPER_THROWINGVENDOR: { name: "throwing-vendor", entrypoint: "GatekeeperVendor" },
          GATEKEEPER_MALFORMEDVENDOR: { name: "malformed-vendor", entrypoint: "GatekeeperVendor" },
        },
        workers: [
          { name: "healthy-vendor", modules: true, compatibilityDate: "2026-02-02", script: HEALTHY_VENDOR },
          { name: "throwing-vendor", modules: true, compatibilityDate: "2026-02-02", script: THROWING_VENDOR },
          { name: "malformed-vendor", modules: true, compatibilityDate: "2026-02-02", script: MALFORMED_VENDOR },
        ],
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      // The reset-recovery tests abort every Durable Object mid-session; capabilities that were
      // held across the abort (e.g. the fire-and-forget AdminSettings install kicked off by the
      // fetch handler) reject on their own schedule, independent of any awaited call.
      if (error.message?.includes("abortAllDurableObjects")) return false;
      // Same, for the test that aborts only the user DO (state.abort with this reason).
      if (error.message?.includes("user-DO reset injected by test")) return false;
    },
  },
});
