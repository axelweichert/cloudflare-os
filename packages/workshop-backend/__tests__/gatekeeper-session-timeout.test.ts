import { describe, expect, it } from "vitest";

const { withGatekeeperSessionTimeout, GATEKEEPER_SESSION_TIMEOUT_MS } =
    await import("../src/overseer.js");

// OWL-1700: hung gadget→gatekeeper session calls must fast-fail instead of hanging the request.
describe("withGatekeeperSessionTimeout", () => {
  it("passes through a result that resolves before the deadline", async () => {
    await expect(withGatekeeperSessionTimeout(Promise.resolve(42), "getSnapshot"))
        .resolves.toBe(42);
  });

  it("propagates a downstream rejection unchanged", async () => {
    await expect(withGatekeeperSessionTimeout(
        Promise.reject(new Error("boom")), "getState"))
        .rejects.toThrow("boom");
  });

  it("rejects a never-settling call once the deadline elapses", async () => {
    const start = Date.now();
    await expect(withGatekeeperSessionTimeout(new Promise<never>(() => {}), "ping"))
        .rejects.toThrow(/timed out after \d+ms/);
    // Fired on the deadline, not instantly and not at the ~30s runtime kill.
    expect(Date.now() - start).toBeGreaterThanOrEqual(GATEKEEPER_SESSION_TIMEOUT_MS - 500);
  }, GATEKEEPER_SESSION_TIMEOUT_MS + 5_000);
});
