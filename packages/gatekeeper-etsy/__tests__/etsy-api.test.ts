import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  computeCodeChallenge,
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
