import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCfAccess, normalizeCfAccess, normalizeToken, ProxmoxError } from "./token.ts";

test("normalizeToken accepts a well-formed Proxmox token", () => {
  const t = "root@pam!cloudflareos=1234abcd-5678-90ef-ghij-klmnopqrstuv";
  assert.equal(normalizeToken(`  ${t}  `), t);
});

test("normalizeToken rejects empty input", () => {
  assert.throws(() => normalizeToken("   "), new ProxmoxError("Ein API-Token ist erforderlich."));
});

test("normalizeToken rejects a token missing the realm/tokenid/secret shape", () => {
  for (const bad of ["root@pam", "root@pam!id", "justastring", "root!id=secret", "root@pam!id="]) {
    assert.throws(
      () => normalizeToken(bad),
      new ProxmoxError(
        'Das sieht nicht nach einem Proxmox-API-Token aus. Erwartet wird die Form "BENUTZER@REALM!TOKEN-ID=GEHEIMNIS".',
      ),
      `expected reject: ${bad}`,
    );
  }
});

test("normalizeCfAccess treats two empty fields as no Access token", () => {
  assert.equal(normalizeCfAccess("", ""), undefined);
  assert.equal(normalizeCfAccess("  ", undefined), undefined);
});

test("normalizeCfAccess trims and returns a complete Access token", () => {
  assert.deepEqual(normalizeCfAccess(" abc.access ", " s3cret "), { clientId: "abc.access", clientSecret: "s3cret" });
});

test("normalizeCfAccess rejects a half-filled Access token", () => {
  for (const [id, secret] of [["abc.access", ""], ["", "s3cret"]]) {
    assert.throws(
      () => normalizeCfAccess(id, secret),
      new ProxmoxError(
        "Ein Cloudflare-Access-Service-Token benötigt sowohl eine Client ID als auch ein Client Secret (oder lassen Sie beide Felder leer).",
      ),
    );
  }
});

test("normalizeCfAccess rejects whitespace inside a value", () => {
  assert.throws(
    () => normalizeCfAccess("abc .access", "s3cret"),
    new ProxmoxError("Client ID und Client Secret des Cloudflare-Access-Tokens dürfen keine Leerzeichen enthalten."),
  );
});

test("effectiveCfAccess sends the current env secret for a stored copy of the deployment token", () => {
  assert.deepEqual(effectiveCfAccess({ clientId: "shared.access", clientSecret: "stale" }, "shared.access", "rotated"), {
    access: { clientId: "shared.access", clientSecret: "rotated" },
    source: "env",
  });
});

test("effectiveCfAccess keeps a connection's own Access token", () => {
  assert.deepEqual(effectiveCfAccess({ clientId: "own.access", clientSecret: "own" }, "shared.access", "rotated"), {
    access: { clientId: "own.access", clientSecret: "own" },
    source: "connection",
  });
  assert.deepEqual(effectiveCfAccess({ clientId: "shared.access", clientSecret: "own" }, "shared.access", undefined), {
    access: { clientId: "shared.access", clientSecret: "own" },
    source: "connection",
  });
});

test("effectiveCfAccess falls back to the env token, or none", () => {
  assert.deepEqual(effectiveCfAccess(undefined, "shared.access", "s"), { access: { clientId: "shared.access", clientSecret: "s" }, source: "env" });
  assert.equal(effectiveCfAccess(undefined, "shared.access", undefined), undefined);
});
