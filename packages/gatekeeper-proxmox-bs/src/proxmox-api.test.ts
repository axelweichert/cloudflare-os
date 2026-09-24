import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToken, ProxmoxError } from "./token.ts";

test("normalizeToken accepts a well-formed Proxmox token", () => {
  const t = "root@pam!cloudflareos=1234abcd-5678-90ef-ghij-klmnopqrstuv";
  assert.equal(normalizeToken(`  ${t}  `), t);
});

test("normalizeToken rejects empty input", () => {
  assert.throws(() => normalizeToken("   "), ProxmoxError);
});

test("normalizeToken rejects a token missing the realm/tokenid/secret shape", () => {
  for (const bad of ["root@pam", "root@pam!id", "justastring", "root!id=secret", "root@pam!id="]) {
    assert.throws(() => normalizeToken(bad), ProxmoxError, `expected reject: ${bad}`);
  }
});
