import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCfAccess, normalizeToken, ProxmoxError } from "./token.ts";

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
