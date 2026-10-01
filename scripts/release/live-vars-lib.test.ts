// Unit gate for the live-var comparator. Runs in the "Build and test" job (node --test over
// scripts/**/*.test.ts), so it gates `main` -- but with NO network: the fixtures stand in for the
// live Workers-settings JSON the ops script reads (see verify-live-vars.ts for the live read).
//
// The precedent is scripts/deploy-scripts.test.ts: an invariant whose violation is silent in prod
// ("the deploy exits zero and still deploys") and therefore "not enforceable by types or by review
// alone". Here the silent failure is OWL-1757: a gatekeeper live without BASE_URL whose "Connect"
// button falls back to localhost, with a deploy that exited zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVars, describeDeviation, expectedLiveVars, extractLiveVars,
  type LiveWorkerSettings,
} from "./live-vars-lib.ts";
import {
  buildWorkerEntry, findDeployablePackages, readDeployInputs, readWranglerConfig,
} from "./manifest-lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = "https://acme.workers.dev";

// A live gatekeeper that got BASE_URL (the correct state): one plain-text var plus a secret, which
// the settings endpoint returns without its value.
function settingsWith(baseUrl: string | undefined): LiveWorkerSettings {
  return {
    bindings: [
      { type: "secret_text", name: "CLIENT_SECRET" },
      ...(baseUrl === undefined ? [] : [{ type: "plain_text", name: "BASE_URL", text: baseUrl }]),
    ],
  };
}

test("expectedLiveVars derives BASE_URL from the real manifest, not a re-implementation", () => {
  // Build the etsy manifest entry from its actual wrangler.jsonc (no bundle needed: vars do not
  // depend on modules). This is the reuse the ticket asks for -- the /gatekeeper/<short> template
  // lives only in manifest-lib.ts.
  const pkg = findDeployablePackages(join(ROOT, "packages"))
    .find((p) => p.name === "gatekeeper-etsy");
  assert.ok(pkg, "gatekeeper-etsy must exist");
  const entry = buildWorkerEntry({
    pkgName: pkg.name,
    config: readWranglerConfig(pkg.dir),
    mainModule: "index.js",
    modules: [],
    deployInputs: readDeployInputs(pkg.dir),
  });
  const expected = expectedLiveVars(entry, ORIGIN);
  assert.equal(expected.BASE_URL, `${ORIGIN}/gatekeeper/etsy`);
});

test("a live gatekeeper missing BASE_URL is flagged -- the OWL-1757 failure", () => {
  const expected = { BASE_URL: `${ORIGIN}/gatekeeper/etsy` };
  const deviations = compareVars(
    "cloudflareos-gk-etsy", expected, extractLiveVars(settingsWith(undefined)));

  assert.equal(deviations.length, 1);
  assert.equal(deviations[0].reason, "missing");
  assert.equal(deviations[0].actual, undefined);
  // The consequence must be spelled out in operator terms, not just "var missing".
  assert.match(describeDeviation(deviations[0]), /localhost/);
});

test("a live gatekeeper with the manifest BASE_URL passes", () => {
  for (const short of ["github", "slack"]) {
    const expected = { BASE_URL: `${ORIGIN}/gatekeeper/${short}` };
    const live = extractLiveVars(settingsWith(`${ORIGIN}/gatekeeper/${short}`));
    assert.deepEqual(compareVars(`cloudflareos-gk-${short}`, expected, live), []);
  }
});

test("a live gatekeeper pointing at the wrong origin is a mismatch, not a pass", () => {
  const expected = { BASE_URL: `${ORIGIN}/gatekeeper/etsy` };
  const live = extractLiveVars(settingsWith("http://localhost:8787/gatekeeper/etsy"));
  const deviations = compareVars("cloudflareos-gk-etsy", expected, live);

  assert.equal(deviations.length, 1);
  assert.equal(deviations[0].reason, "mismatch");
  assert.equal(deviations[0].actual, "http://localhost:8787/gatekeeper/etsy");
});

test("a trailing slash on the origin does not produce a phantom mismatch", () => {
  const pkg = findDeployablePackages(join(ROOT, "packages"))
    .find((p) => p.name === "gatekeeper-github");
  assert.ok(pkg);
  const entry = buildWorkerEntry({
    pkgName: pkg.name, config: readWranglerConfig(pkg.dir),
    mainModule: "index.js", modules: [], deployInputs: readDeployInputs(pkg.dir),
  });
  const expected = expectedLiveVars(entry, "https://acme.workers.dev/");
  assert.equal(expected.BASE_URL, "https://acme.workers.dev/gatekeeper/github");
});
