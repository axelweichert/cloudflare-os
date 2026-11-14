// The answers an observer's own UserAccount reuses when verifyObserverAccess asks whether it can read
// an account's telemetry: how long each is reused, and that none outlives the API token that learned
// it. A pasted token records no scopes, so the live probe is the only check of its permissions.
//
// Each test runs inside the account's own context, as in access-token.test.ts.

import { env, runInDurableObject } from "cloudflare:test";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserAccount } from "../worker.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const START = Date.UTC(2026, 7, 14, 12);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let accounts = 0;

/** Runs `test` in an account connected with the pasted API token `token-1`. */
function inAccount<R>(test: (account: UserAccount, state: DurableObjectState) => Promise<R>): Promise<R> {
  return runInDurableObject(env.USER_ACCOUNT.getByName(`telemetry-access-${accounts++}`), (account, state) => {
    state.storage.kv.put("credentials", { apiToken: "token-1" });
    return test(account, state);
  });
}

/**
 * Stubs Cloudflare: the telemetry API answers each probe with `statusFor(token, accountId)`.
 * Returns the probes it was sent, as `<token> <accountId>`.
 */
function cloudflare(statusFor: (token: string, accountId: string) => number | Promise<number>): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("Authorization")!.slice("Bearer ".length);
    // `/client/v4/accounts/<accountId>/workers/observability/telemetry/keys`
    const accountId = new URL(url).pathname.split("/")[4]!;
    asked.push(`${token} ${accountId}`);
    const status = await statusFor(token, accountId);
    return status === 200
      ? Response.json({ success: true, result: [{ key: "$metadata.level", type: "string", lastSeenAt: 1 }] })
      : Response.json({ success: false, errors: [{ code: 10000, message: "refused" }] }, { status });
  }));
  return asked;
}

describe("UserAccount.checkTelemetryAccess", () => {
  it.each([
    ["an allowed", 200, true, 15 * 60_000],
    ["a denied", 403, false, 15_000],
  ])("reuses %s answer until it expires", async (_, status, allowed, ttl) => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const asked = cloudflare(() => status);

    await inAccount(async account => {
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([allowed]);
      vi.setSystemTime(START + ttl - 1);
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([allowed]);
      expect(asked).toHaveLength(1);

      vi.setSystemTime(START + ttl);
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([allowed]);
    });
    expect(asked).toHaveLength(2);
  });

  it("asks afresh once the account is reconnected", async () => {
    // A reconnect may paste another Cloudflare user's token, who must not inherit the first's access.
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const asked = cloudflare(token => token === "token-1" ? 200 : 403);

    await inAccount(async (account, { storage }) => {
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([true]);
      await account.commitReconnect(stageCredentials(storage.kv, { apiToken: "token-2" }, Date.now()));

      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([false]);
    });
    expect(asked).toEqual([`token-1 ${ACCOUNT_ID}`, `token-2 ${ACCOUNT_ID}`]);
  });

  it("never caches one token's answer under the token that replaced it mid-check", async () => {
    // Alice's check of two accounts is overtaken by a reconnect with Bob's token, which can read neither.
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const asked = cloudflare(async (token, accountId) => {
      if (token !== "token-1") return 403;
      if (accountId === ACCOUNT_ID) {
        reached.resolve();
        await release.promise;
      }
      return 200;
    });

    await inAccount(async (account, { storage }) => {
      const check = account.checkTelemetryAccess([ACCOUNT_ID, OTHER_ACCOUNT_ID]);
      await reached.promise;
      await account.commitReconnect(stageCredentials(storage.kv, { apiToken: "token-2" }, Date.now()));
      release.resolve();

      // Its answers come from two principals, so it can't answer for either.
      await expect(check).rejects.toThrow("reconnected");
      expect(await account.checkTelemetryAccess([OTHER_ACCOUNT_ID])).toEqual([false]);
      // The first token's allowed answer was not kept for the token that replaced it.
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([false]);
    });
    expect(asked).not.toContain(`token-1 ${OTHER_ACCOUNT_ID}`);
  });

  it("denies a connection that no longer holds a token, whatever it learned before", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const asked = cloudflare(() => 200);

    await inAccount(async (account, { storage }) => {
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([true]);
      storage.kv.delete("credentials");

      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([false]);
    });
    expect(asked).toHaveLength(1);
  });

  it("fails rather than denies when Cloudflare can't answer, and asks again next time", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const statuses = [500, 200];
    const asked = cloudflare(() => statuses.shift()!);

    await inAccount(async account => {
      await expect(account.checkTelemetryAccess([ACCOUNT_ID])).rejects.toThrow();
      expect(await account.checkTelemetryAccess([ACCOUNT_ID])).toEqual([true]);
    });
    expect(asked).toHaveLength(2);
  });
});
