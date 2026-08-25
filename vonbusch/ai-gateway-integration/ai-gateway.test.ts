// vonBuschOS — AI-Gateway-Integration Tests (VON-1806 / K8)
// Ausführen:  npx tsx --test vonbusch/ai-gateway-integration/ai-gateway.test.ts   (workerd-frei)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGatewayEnv,
  validateGatewayEnv,
  VONBUSCH_GATEWAY_NAME,
  VONBUSCH_DEFAULT_PROVIDERS,
} from "./config.ts";
import {
  estimateCostUsd,
  periodKey,
  BudgetLedger,
  MemoryBudgetStore,
  DEFAULT_PRICE_TABLE,
  FALLBACK_PRICE,
} from "./cost-budget.ts";
import { interpretGuardrailOutcome, VONBUSCH_GUARDRAIL_POLICY } from "./guardrails.ts";

const ACCT = "6d2a1d59a1b2c3d4e5f60718293a4b5c"; // 32-hex Platzhalter (NFR-Prefix 6d2a1d59…)
const DAY = Date.UTC(2026, 7, 25, 12, 0, 0); // 2026-08-25
const NEXT_DAY = Date.UTC(2026, 7, 26, 0, 30, 0);

// --------------------------------------------------------------------------- config
test("buildGatewayEnv: richtet Env auf vonbusch-aigateway", () => {
  const env = buildGatewayEnv({ accountId: ACCT });
  assert.equal(env.CF_AI_GATEWAY, VONBUSCH_GATEWAY_NAME);
  assert.equal(env.CF_AI_GATEWAY_ACCOUNT_ID, ACCT);
  assert.equal(env.CF_AI_GATEWAY_PROVIDERS, VONBUSCH_DEFAULT_PROVIDERS.join(","));
  assert.equal(env.CF_AI_GATEWAY_API_TOKEN, undefined);
});

test("buildGatewayEnv: normalisiert Account-ID (trim/lowercase)", () => {
  const env = buildGatewayEnv({ accountId: `  ${ACCT.toUpperCase()}  ` });
  assert.equal(env.CF_AI_GATEWAY_ACCOUNT_ID, ACCT);
});

test("buildGatewayEnv: wirft bei ungültiger Account-ID", () => {
  assert.throws(() => buildGatewayEnv({ accountId: "nope" }));
  assert.throws(() => buildGatewayEnv({ accountId: "" }));
});

test("buildGatewayEnv: USE_BINDING=false setzt HTTPS-Transport", () => {
  const env = buildGatewayEnv({ accountId: ACCT, useBinding: false, apiToken: "t" });
  assert.equal(env.CF_AI_GATEWAY_USE_BINDING, "false");
  assert.equal(env.CF_AI_GATEWAY_API_TOKEN, "t");
});

test("buildGatewayEnv: unbekannter Provider wirft", () => {
  assert.throws(() => buildGatewayEnv({ accountId: ACCT, providers: ["mistral" as any] }));
});

test("validateGatewayEnv: gültiger Binding-Env ist ok (kein Token nötig)", () => {
  const r = validateGatewayEnv(buildGatewayEnv({ accountId: ACCT }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.parsedProviders, VONBUSCH_DEFAULT_PROVIDERS);
});

test("validateGatewayEnv: HTTPS-Transport ohne Token schlägt fehl", () => {
  const env = buildGatewayEnv({ accountId: ACCT, useBinding: false, apiToken: "t" });
  delete env.CF_AI_GATEWAY_API_TOKEN;
  const r = validateGatewayEnv(env);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "CF_AI_GATEWAY_API_TOKEN"));
});

test("validateGatewayEnv: Google-Provider verlangt Token (reitet immer HTTPS)", () => {
  const env = buildGatewayEnv({ accountId: ACCT, providers: ["anthropic", "google"] });
  const r = validateGatewayEnv(env); // ohne Token
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "CF_AI_GATEWAY_API_TOKEN"));
  // mit Token ok:
  const r2 = validateGatewayEnv({ ...env, CF_AI_GATEWAY_API_TOKEN: "t" });
  assert.equal(r2.ok, true);
});

test("validateGatewayEnv: fehlende Account-ID / leere Provider melden", () => {
  const r = validateGatewayEnv({ CF_AI_GATEWAY: "x", CF_AI_GATEWAY_PROVIDERS: "" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "CF_AI_GATEWAY_ACCOUNT_ID"));
  assert.ok(r.issues.some((i) => i.field === "CF_AI_GATEWAY_PROVIDERS"));
});

// --------------------------------------------------------------------------- cost estimate
test("estimateCostUsd: rechnet input+output korrekt", () => {
  // 1M input @3 + 1M output @15 = 18 USD (claude-sonnet-5)
  const c = estimateCostUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(c, 18);
});

test("estimateCostUsd: Cache-Tokens fließen ein", () => {
  const c = estimateCostUsd("claude-opus-4-8", {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 2_000_000, cacheWriteTokens: 0,
  });
  assert.equal(c, DEFAULT_PRICE_TABLE["claude-opus-4-8"].cacheRead! * 2);
});

test("estimateCostUsd: unbekanntes Modell nutzt konservativen Fallback", () => {
  const c = estimateCostUsd("brandneu-x", { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(c, FALLBACK_PRICE.input);
});

// --------------------------------------------------------------------------- periodKey
test("periodKey: UTC Tag und Monat", () => {
  assert.equal(periodKey("day", DAY), "2026-08-25");
  assert.equal(periodKey("month", DAY), "2026-08");
});

// --------------------------------------------------------------------------- BudgetLedger
test("BudgetLedger: erlaubt unter Cap, blockt über Cap", async () => {
  const ledger = new BudgetLedger({ store: new MemoryBudgetStore(), capUsd: 1.0 });
  // Schätzung: 0.1M in @3 + 0.1M out @15 = 0.3+1.5 =1.8 USD > 1.0 → deny
  const big = await ledger.check("u1", "claude-sonnet-5", { inputTokens: 100_000, outputTokens: 100_000 }, DAY);
  assert.equal(big.allow, false);
  assert.ok(big.reason);
  // kleiner Call: 10k in @3 + 10k out @15 = 0.18 USD → allow
  const small = await ledger.check("u1", "claude-sonnet-5", { inputTokens: 10_000, outputTokens: 10_000 }, DAY);
  assert.equal(small.allow, true);
  assert.ok(small.remainingUsd > 0 && small.remainingUsd < 1.0);
});

test("BudgetLedger: record akkumuliert und blockt danach", async () => {
  const ledger = new BudgetLedger({ store: new MemoryBudgetStore(), capUsd: 1.0 });
  await ledger.record("u1", 0.9, DAY);
  assert.equal(await ledger.spentFor("u1", DAY), 0.9);
  // jetzt würde ein 0.18-USD-Call auf 1.08 > 1.0 laufen → deny
  const dec = await ledger.check("u1", "claude-sonnet-5", { inputTokens: 10_000, outputTokens: 10_000 }, DAY);
  assert.equal(dec.allow, false);
  assert.equal(dec.spentUsd, 0.9);
});

test("BudgetLedger: Periode setzt am nächsten UTC-Tag zurück", async () => {
  const ledger = new BudgetLedger({ store: new MemoryBudgetStore(), capUsd: 1.0, period: "day" });
  await ledger.record("u1", 0.95, DAY);
  assert.equal(await ledger.spentFor("u1", DAY), 0.95);
  assert.equal(await ledger.spentFor("u1", NEXT_DAY), 0); // neuer Tag, frisches Budget
});

test("BudgetLedger: per-User-Cap-Override greift", async () => {
  const ledger = new BudgetLedger({
    store: new MemoryBudgetStore(), capUsd: 1.0, perUserCapUsd: { power: 100 },
  });
  const dec = await ledger.check("power", "claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 100_000 }, DAY);
  assert.equal(dec.capUsd, 100);
  assert.equal(dec.allow, true);
});

test("BudgetLedger: rollup liefert Chargeback je Nutzer", async () => {
  const ledger = new BudgetLedger({ store: new MemoryBudgetStore(), capUsd: 10 });
  await ledger.record("a", 1.5, DAY);
  await ledger.record("a", 0.5, DAY);
  await ledger.record("b", 3.0, DAY);
  const roll = await ledger.rollup(DAY);
  const a = roll.find((r) => r.userId === "a")!;
  const b = roll.find((r) => r.userId === "b")!;
  assert.equal(a.spentUsd, 2.0);
  assert.equal(a.calls, 2);
  assert.equal(b.spentUsd, 3.0);
});

test("BudgetLedger: negative Werte werfen", async () => {
  assert.throws(() => new BudgetLedger({ store: new MemoryBudgetStore(), capUsd: -1 }));
  const ledger = new BudgetLedger({ store: new MemoryBudgetStore(), capUsd: 1 });
  await assert.rejects(() => ledger.record("u", -0.5, DAY));
});

// --------------------------------------------------------------------------- guardrails
test("Policy: Finanzdaten auf FLAG, nicht BLOCK (VON-157)", () => {
  const fin = VONBUSCH_GUARDRAIL_POLICY.rules.find((r) => r.category === "financial")!;
  assert.equal(fin.action, "flag");
  const cred = VONBUSCH_GUARDRAIL_POLICY.rules.find((r) => r.category === "credentials")!;
  assert.equal(cred.action, "block");
});

test("interpretGuardrailOutcome: 4xx mit Header → blocked", () => {
  const o = interpretGuardrailOutcome({ status: 403, headers: { "cf-aig-guardrail": "hate" } });
  assert.equal(o.blocked, true);
  assert.deepEqual(o.categories, ["hate"]);
  assert.ok(o.message);
});

test("interpretGuardrailOutcome: 4xx mit Guardrail-Body → blocked", () => {
  const o = interpretGuardrailOutcome({
    status: 400,
    body: { error: { type: "guardrail_violation", message: "blocked by guardrail" } },
  });
  assert.equal(o.blocked, true);
});

test("interpretGuardrailOutcome: 2xx flagged → flagged, nicht blocked", () => {
  const o = interpretGuardrailOutcome({ status: 200, headers: { "cf-aig-guardrail": "flagged" } });
  assert.equal(o.blocked, false);
  assert.equal(o.flagged, true);
});

test("interpretGuardrailOutcome: normaler 200 → weder blocked noch flagged", () => {
  const o = interpretGuardrailOutcome({ status: 200, headers: { "content-type": "application/json" } });
  assert.equal(o.blocked, false);
  assert.equal(o.flagged, false);
  assert.deepEqual(o.categories, []);
});

test("interpretGuardrailOutcome: 4xx OHNE Guardrail-Signal ist kein Guardrail-Block", () => {
  const o = interpretGuardrailOutcome({ status: 429, body: { error: { type: "rate_limit" } } });
  assert.equal(o.blocked, false);
});
