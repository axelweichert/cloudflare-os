// `UserAccount.getAccessToken` serves the pasted API token (OWL-1618: this gatekeeper connects by
// API token, so there is no refresh path), and a reconnect's token replaces it only once the
// Workshop commits the stage that reconnect produced.
//
// Each test runs inside the account's own context: a promise the test resolves would otherwise hand
// the account's continuation to the test's context, which may not touch the account's I/O.

import { env, runInDurableObject } from "cloudflare:test";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { describe, expect, it } from "vitest";
import type { UserAccount } from "../worker.js";

let accounts = 0;

/** Runs `test` in a fresh account, connected with `token-1` unless `connected` is false. */
function inAccount<R>(test: (account: UserAccount, state: DurableObjectState) => Promise<R>,
  connected = true): Promise<R> {
  return runInDurableObject(env.USER_ACCOUNT.getByName(`account-${accounts++}`), (account, state) => {
    if (connected) state.storage.kv.put("credentials", { apiToken: "token-1" });
    return test(account, state);
  });
}

describe("UserAccount.getAccessToken", () => {
  it("serves the pasted token, and none while the account isn't connected", async () => {
    await inAccount(async account => {
      expect(await account.getAccessToken()).toBe("token-1");
    });
    await inAccount(async account => {
      expect(await account.getAccessToken()).toBeNull();
    }, false);
  });

  it("keeps serving the live token while a reconnect is staged, and the new one once committed", async () => {
    await inAccount(async (account, { storage }) => {
      const stageId = stageCredentials(storage.kv, { apiToken: "token-2" }, Date.now());
      expect(await account.getAccessToken()).toBe("token-1");

      await account.commitReconnect(stageId);
      expect(await account.getAccessToken()).toBe("token-2");
      expect(storage.kv.get("credentials")).toEqual({ apiToken: "token-2" });
    });
  });

  it("refuses to commit a stage a later reconnect replaced, leaving the live token", async () => {
    await inAccount(async (account, { storage }) => {
      const overtaken = stageCredentials(storage.kv, { apiToken: "token-2" }, Date.now());
      stageCredentials(storage.kv, { apiToken: "token-3" }, Date.now());

      await expect(account.commitReconnect(overtaken)).rejects.toThrow("No reconnect is awaiting confirmation");
      expect(await account.getAccessToken()).toBe("token-1");
    });
  });
});
