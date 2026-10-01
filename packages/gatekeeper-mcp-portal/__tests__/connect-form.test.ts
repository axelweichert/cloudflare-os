import { describe, expect, it } from "vitest";

import { redirectBlockedHtml } from "../src/connect-form.js";

describe("portal redirectBlockedHtml", () => {
  const html = redirectBlockedHtml(
    "/gatekeeper/mcp-portal/DOID/NONCE",
    "https://cloudflareos.weichert.at/gatekeeper/mcp-portal/oauth",
  );

  it("shows the live redirect URI so the user can allowlist it", () => {
    expect(html).toContain("https://cloudflareos.weichert.at/gatekeeper/mcp-portal/oauth");
    expect(html).not.toContain("localhost");
  });

  it("offers a manual client form that POSTs back to the connect path", () => {
    expect(html).toContain('action="/gatekeeper/mcp-portal/DOID/NONCE"');
    expect(html).toContain('name="client_id"');
    expect(html).toContain('name="client_secret"');
    // The secret input must be masked.
    expect(html).toMatch(/name="client_secret"[^>]*type="password"|type="password"[^>]*name="client_secret"/);
  });

  it("omits a server-URL field — the portal endpoint is fixed by configuration", () => {
    expect(html).not.toContain('name="url"');
  });

  it("escapes an error message rather than rendering a raw blob", () => {
    const withErr = redirectBlockedHtml("/p", "https://x/oauth", "<script>x</script>");
    expect(withErr).toContain("&lt;script&gt;");
    expect(withErr).not.toContain("<script>x");
  });
});
