import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

// OWL-1752: a single misbehaving gatekeeper must never topple the whole gatekeeper list.
//
// listGatekeeperVendors iterates every bound GATEKEEPER_* vendor, calling describe() +
// getSupportedResources() and returning the results as ONE array that Cap'n Web serializes to the
// client as a unit. The integration config binds three hermetic vendors (see
// vitest.integration.config.ts): a healthy one, one that throws, and one that resolves with
// structurally-broken data. The reply must list the healthy vendor and downgrade both bad ones to
// `unavailable` tiles -- never reject the whole call (which the UI surfaces as
// "Beim Laden Deiner Gatekeeper ist etwas schiefgelaufen").

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

describe("listGatekeeperVendors vendor isolation", () => {
  it("lists healthy vendors and degrades broken/malformed ones to unavailable tiles", async () => {
    using publicApi = await connect();
    const name = username("gkiso");
    const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (token === null) throw new Error("Failed to create account.");
    using authenticated = await publicApi.authenticate(token);

    // The whole call must resolve -- one bad vendor rejecting it is the regression we guard against.
    const list = await authenticated.listGatekeeperVendors();

    const healthy = list.find(v => v.id === "healthyvendor");
    const throwing = list.find(v => v.id === "throwingvendor");
    const malformed = list.find(v => v.id === "malformedvendor");

    expect(healthy, "healthy vendor is listed").toBeTruthy();
    expect(healthy?.unavailable).toBeFalsy();
    expect(healthy?.description.displayName).toBe("Healthy");

    expect(throwing?.unavailable, "throwing vendor downgraded to a tile").toBe(true);
    expect(malformed?.unavailable, "malformed vendor downgraded to a tile").toBe(true);

    // A downgraded tile always carries a well-formed, renderable description.
    expect(typeof malformed?.description.displayName).toBe("string");
    expect(typeof malformed?.description.url).toBe("string");
  });
});
