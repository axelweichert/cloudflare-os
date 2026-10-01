import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  computeCodeChallenge,
  EtsyApi,
  ETSY_SCOPES,
  generateCodeVerifier,
} from "../src/etsy-api";

describe("base64UrlEncode", () => {
  it("emits base64url without padding or +/ characters", () => {
    // Standard base64 of [0xfb, 0xff] is "+/8="; base64url drops padding and maps +/ to -_.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("round-trips ASCII bytes", () => {
    expect(base64UrlEncode(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
  });
});

describe("PKCE S256", () => {
  it("matches the RFC 7636 Appendix B test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await computeCodeChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates a 43-char base64url verifier from 32 random bytes", () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateCodeVerifier()).not.toBe(v);
  });
});

describe("EtsyApi default fetch binding (OWL-1795 regression)", () => {
  it("invokes the global fetch without an illegal this-binding", async () => {
    // Workers' native fetch throws "Illegal invocation" when called with this !== globalThis.
    // Reproduce that constraint with a this-sensitive fake global fetch; a plain mock would not.
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = function (this: unknown, input: unknown) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError(
          "Illegal invocation: function called with incorrect `this` reference.",
        );
      }
      seen.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ results: [{ shop_id: 42, shop_name: "lindanahandmade" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch;
    try {
      // No fetchImpl -> exercises the default `fetch.bind(globalThis)` path (the configurator path).
      const api = new EtsyApi({ apiBase: "https://api.etsy.test", keystring: "k" });
      await expect(api.resolveShopId("lindanahandmade")).resolves.toBe("42");
      expect(seen).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("ETSY_SCOPES", () => {
  it("stays exactly the OWL-1740 signed-off scope set", () => {
    // Guardrail: widening this set is a security-review change, not a silent edit.
    expect(ETSY_SCOPES).toEqual([
      "shops_r",
      "listings_r",
      "transactions_r",
      "listings_w",
      "transactions_w",
    ]);
  });
});
