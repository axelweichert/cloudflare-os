// Post-deploy/ops check (NOT a `main` gate -- see live-vars-lib.ts and manifest-lib.ts): reads the
// LIVE settings of each gatekeeper worker on the instance, resolves the manifest's Soll against the
// instance origin, and fails (exit != 0) with a plain-text consequence on any deviation.
//
// This is the half CI cannot do: CI has no per-instance state or creds and does not know which
// gatekeepers are installed where. Run it after a deploy, or on demand, with the instance's token.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/release/verify-live-vars.ts --origin=https://<instance>
//   # optionally limit to specific gatekeepers (short names): ... etsy github
//
// Read-only: it only GETs /accounts/<acc>/workers/scripts/<name>/settings. It never mutates a
// worker. Fixing a deviation is a separate, explicitly-authorized deploy step.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkerEntry, findDeployablePackages, readDeployInputs, readWranglerConfig,
} from "./manifest-lib.ts";
import {
  compareVars, describeDeviation, expectedLiveVars, extractLiveVars,
  type LiveWorkerSettings, type VarDeviation,
} from "./live-vars-lib.ts";

// Weichert.at. The ONLY account this script is allowed to touch (AGENTS.md hard rule, OWL-1434).
// Foreign accounts -- the von-busch account 6d2a1d5945f8b63047a1d59a9f94de21 above all -- are tabu.
const ALLOWED_ACCOUNT_ID = "6b9b3fa0e9f6be87faf7ca1b212641a3";
const FORBIDDEN_ACCOUNT_IDS = new Set(["6d2a1d5945f8b63047a1d59a9f94de21"]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Live worker name for a gatekeeper package, matching the root wrangler.jsonc service bindings. */
function liveWorkerName(shortName: string): string {
  return `cloudflareos-gk-${shortName}`;
}

async function readWorkerSettings(
  accountId: string, workerName: string, token: string,
): Promise<LiveWorkerSettings | "not-deployed"> {
  if (accountId !== ALLOWED_ACCOUNT_ID || FORBIDDEN_ACCOUNT_IDS.has(accountId)) {
    throw new Error(`refusing to call the Cloudflare API for account ${accountId}: ` +
        `only Weichert.at (${ALLOWED_ACCOUNT_ID}) is allowed`);
  }
  const path = `/accounts/${accountId}/workers/scripts/${workerName}/settings`;
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return "not-deployed";
  const body = await response.json().catch(() => ({})) as
      { success?: boolean; errors?: unknown; result?: LiveWorkerSettings };
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API GET ${path} failed with ${response.status}: ` +
        JSON.stringify(body.errors ?? body));
  }
  return body.result ?? {};
}

function parseArgs(argv: string[]): { origin: string; only: Set<string> } {
  const only = new Set<string>();
  let origin = process.env.PUBLIC_BASE_URL ?? "";
  for (const arg of argv) {
    if (arg.startsWith("--origin=")) origin = arg.slice("--origin=".length);
    else if (!arg.startsWith("--")) only.add(arg);
  }
  return { origin, only };
}

async function main(): Promise<number> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error(
      "CLOUDFLARE_API_TOKEN is not set. This read-only check needs an instance-scoped token;\n" +
      "request it env-injected from the CISO (/OWL/agents/ciso) -- do NOT ask the board for it.");
    return 2;
  }
  const { origin, only } = parseArgs(process.argv.slice(2));
  if (!origin) {
    console.error("No instance origin given. Pass --origin=https://<instance> " +
        "(or set PUBLIC_BASE_URL). This is the value $PUBLIC_BASE_URL resolves to.");
    return 2;
  }

  // Soll: every gatekeeper's manifest entry, built from its real wrangler.jsonc (vars do not depend
  // on modules, so no bundle is needed). expectedLiveVars reads entry.vars -- the manifest's own
  // BASE_URL template -- so the /gatekeeper/<short> rule lives only in manifest-lib.ts.
  const gatekeepers = findDeployablePackages(join(ROOT, "packages"))
    .filter((pkg) => pkg.name.startsWith("gatekeeper-"))
    .map((pkg) => buildWorkerEntry({
      pkgName: pkg.name,
      config: readWranglerConfig(pkg.dir),
      mainModule: "index.js",
      modules: [],
      deployInputs: readDeployInputs(pkg.dir),
    }))
    .filter((entry) => only.size === 0 || only.has(entry.shortName!));

  const deviations: VarDeviation[] = [];
  const notDeployed: string[] = [];
  let checked = 0;

  for (const entry of gatekeepers) {
    const workerName = liveWorkerName(entry.shortName!);
    const settings = await readWorkerSettings(ALLOWED_ACCOUNT_ID, workerName, token);
    if (settings === "not-deployed") {
      notDeployed.push(workerName);
      continue;
    }
    checked += 1;
    const expected = expectedLiveVars(entry, origin);
    deviations.push(...compareVars(workerName, expected, extractLiveVars(settings)));
  }

  console.log(`Checked ${checked} live gatekeeper worker(s) on Weichert.at against the manifest.`);
  if (notDeployed.length > 0) {
    console.log(`Not deployed (skipped): ${notDeployed.join(", ")}`);
  }

  if (deviations.length === 0) {
    console.log("All live gatekeepers carry the vars the manifest prescribes.");
    return 0;
  }

  console.error(`\n${deviations.length} live gatekeeper var deviation(s):`);
  for (const d of deviations) console.error(`  - ${describeDeviation(d)}`);
  console.error("\nA live worker misconfigured this way deployed green and exited zero (OWL-1757). " +
      "Fixing it is a separate, explicitly-authorized deploy step -- do not mutate workers here.");
  return 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
