// Soll/Ist contract for a LIVE gatekeeper's plain-text vars.
//
// Background (OWL-1757): `cloudflareos-gk-etsy` was pushed live via the package `deploy` path,
// bypassing the release manifest, so it never received `BASE_URL`. The code fallback
// `http://localhost:8787/...` took over in production and the "Connect" button pointed at
// localhost. The deploy exited zero -- the failure was silent.
//
// The defect was never the package `deploy` script (19/19 gatekeepers run the same one): it was
// that nothing ever checks whether a *live-running* gatekeeper carries the vars the manifest
// prescribes for it. The Soll is computable from the manifest (manifest-lib.ts:
// `vars.BASE_URL = $PUBLIC_BASE_URL/gatekeeper/<short>`); the Ist is readable from the Workers
// API. This module is the pure comparator both sides call.
//
// CTO split (OWL-1763): this comparator is pure (no network) and gates `main` via a unit test in
// the "Build and test" job. The live read against the Cloudflare API lives in verify-live-vars.ts
// and is a post-deploy/ops step, NOT a `main` gate -- CI has no per-instance state or creds and
// does not know which gatekeepers are installed where, so a `main` gate over live state would be
// green while the live worker is misconfigured (exactly the OWL-1757 case).

import type { WorkerEntry } from "./manifest-lib.ts";

/** The manifest placeholder the deploy service resolves to the instance's public origin. */
export const PUBLIC_BASE_URL_PLACEHOLDER = "$PUBLIC_BASE_URL";

/**
 * Vars every installed gatekeeper MUST carry on its live worker. The ticket minimum is `BASE_URL`;
 * the set is closed so a new required var is a conscious edit here, checked by the unit gate.
 */
export const REQUIRED_GATEKEEPER_VARS = ["BASE_URL"] as const;

/** One way a live worker's vars disagree with what the manifest prescribes. */
export interface VarDeviation {
  /** Live worker name, e.g. `cloudflareos-gk-etsy`. */
  worker: string;
  /** Var name that disagrees, e.g. `BASE_URL`. */
  var: string;
  /** Resolved value the manifest prescribes. */
  expected: string;
  /** Live value, or `undefined` when the var is absent on the live worker. */
  actual: string | undefined;
  /** `missing` = absent live; `mismatch` = present but wrong. */
  reason: "missing" | "mismatch";
}

/** One binding from `GET /accounts/<acc>/workers/scripts/<name>/settings`. */
export interface LiveBinding {
  type: string;
  name: string;
  /** Present on plain-text vars; absent on secrets (their value is never returned). */
  text?: string;
  [key: string]: unknown;
}

/** The subset of a live worker's settings JSON this comparator reads. */
export interface LiveWorkerSettings {
  bindings?: LiveBinding[];
}

function stripTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

/**
 * Resolve a manifest var template (carrying `$PUBLIC_BASE_URL`) against a concrete instance
 * origin. Mirrors the deploy-side renderer for the one placeholder a gatekeeper var can hold.
 */
export function resolveVarTemplate(template: string, origin: string): string {
  return template.split(PUBLIC_BASE_URL_PLACEHOLDER).join(stripTrailingSlash(origin));
}

/**
 * The Soll for one gatekeeper: the required vars from its manifest entry, resolved against the
 * instance origin. Reuses the manifest's own `vars` (so the `/gatekeeper/<short>` template lives
 * in exactly one place, manifest-lib.ts) rather than re-deriving BASE_URL here.
 */
export function expectedLiveVars(
  entry: WorkerEntry,
  origin: string,
  required: readonly string[] = REQUIRED_GATEKEEPER_VARS,
): Record<string, string> {
  const expected: Record<string, string> = {};
  for (const name of required) {
    const template = entry.vars[name];
    if (typeof template === "string") expected[name] = resolveVarTemplate(template, origin);
  }
  return expected;
}

/** The Ist for one gatekeeper: its live plain-text vars, pulled from the settings JSON. */
export function extractLiveVars(settings: LiveWorkerSettings): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const binding of settings.bindings ?? []) {
    if (binding.type === "plain_text" && typeof binding.text === "string") {
      vars[binding.name] = binding.text;
    }
  }
  return vars;
}

/**
 * Pure comparator: Soll (resolved expected vars) vs Ist (live vars). Returns every required var
 * that is missing or mismatched. Empty list == live worker matches the manifest.
 */
export function compareVars(
  worker: string,
  expected: Record<string, string>,
  live: Record<string, string>,
  required: readonly string[] = REQUIRED_GATEKEEPER_VARS,
): VarDeviation[] {
  const deviations: VarDeviation[] = [];
  for (const name of required) {
    const want = expected[name];
    if (want === undefined) continue; // manifest prescribes nothing for this var on this worker
    const got = live[name];
    if (got === undefined) {
      deviations.push({ worker, var: name, expected: want, actual: undefined, reason: "missing" });
    } else if (got !== want) {
      deviations.push({ worker, var: name, expected: want, actual: got, reason: "mismatch" });
    }
  }
  return deviations;
}

/**
 * Plain-text consequence line for one deviation -- the message the OWL-1757 silent deploy never
 * produced. A missing/wrong BASE_URL is spelled out in terms the operator feels: "Connect" points
 * at localhost.
 */
export function describeDeviation(d: VarDeviation): string {
  const head = d.reason === "missing"
    ? `${d.worker} is live but has no ${d.var} var`
    : `${d.worker} ${d.var} is ${JSON.stringify(d.actual)}, manifest expects ${JSON.stringify(d.expected)}`;
  const consequence = d.var === "BASE_URL"
    ? ` -- the "Connect" button falls back to localhost (http://localhost:8787/...) and points nowhere.`
    : ` -- expected ${JSON.stringify(d.expected)}.`;
  return head + consequence;
}
