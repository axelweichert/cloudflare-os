import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
        durableObjects: {
          ROBOMON_GATEKEEPER: { className: "RobomonGatekeeper", useSQLite: true },
        },
        kvNamespaces: ["AUTHMON_KV"],
        serviceBindings: {
          TEST_CONTROL: { name: kCurrentWorker, entrypoint: "TestControl" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
