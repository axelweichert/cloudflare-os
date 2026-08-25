// Prüft die gebauten Firmen-Workflow-Blueprints, ohne die laufende Workshop:
//   • das `.gadget`-Archiv ist install-fähig (Prefix/Magic/Version, Content-Länge stimmt),
//   • der gzip(Yjs-V2)-Snapshot dekodiert zu genau den Gadget-Dateien der Quelle,
//   • die Bindings sind in sich stimmig (agentSpawner.env verweist nur auf deklarierte,
//     spawnerOnly-Gatekeeper-Bindings),
//   • das Sidecar passt zum Manifest und erfüllt die Regeln von build-format-blueprints.mjs.
//
// Lauf:  npx tsx --test vonbusch/format-blueprints/blueprints.test.ts   (vom Repo-Root)
// Parse ist bewusst nachgebaut (wie scripts/import-format-blueprint.mjs), damit der Test ohne
// TypeScript-Build der Worker-Pakete läuft. Muss mit src/blueprint-archive.ts übereinstimmen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "packages", "workshop-backend", "package.json"));
const Y = require("yjs");

const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;
// Muss mit OUTPUT_ICONS in scripts/build-format-blueprints.mjs übereinstimmen.
const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
  "kanban", "chartBar", "table", "notebook", "listChecks"];

function parseArchive(bytes: Uint8Array) {
  assert.ok(bytes.byteLength > PREFIX_BYTES, "Archiv zu kurz");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getBigUint64(0), MAGIC, "falsche Magic");
  assert.equal(view.getUint32(8), VERSION, "falsche Version");
  const metaLen = view.getUint32(12);
  const contentLen = Number(view.getBigUint64(16));
  assert.ok(metaLen > 0, "leere Metadaten");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metaLen)));
  const content = bytes.subarray(PREFIX_BYTES + metaLen);
  assert.equal(content.byteLength, contentLen, "Content-Länge im Prefix stimmt nicht");
  return { metadata, content };
}

function decodeFiles(gzipped: Uint8Array): Record<string, string> {
  const update = new Uint8Array(gunzipSync(Buffer.from(gzipped)));
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  const root = doc.getMap();
  const files: Record<string, string> = {};
  for (const [k, v] of root.entries()) files[k] = v.toString();
  return files;
}

const srcDir = join(here, "src");
const names = (await readdir(srcDir, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

assert.ok(names.length >= 2, "es sollten mindestens zwei Workflow-Blueprints existieren");

for (const name of names) {
  test(`Blueprint "${name}" ist install-fähig und stimmig`, async () => {
    const dir = join(srcDir, name);
    const manifest = JSON.parse(await readFile(join(dir, "blueprint.json"), "utf8"));

    // --- Archiv + Sidecar existieren und parsen ---
    const archiveBytes = new Uint8Array(await readFile(join(here, `${name}.gadget`)));
    const { metadata, content } = parseArchive(archiveBytes);
    const sidecar = JSON.parse(await readFile(join(here, `${name}.json`), "utf8"));

    // --- Snapshot dekodiert zu genau den Quell-Dateien (ohne blueprint.json) ---
    const files = decodeFiles(content);
    const srcFiles = (await readdir(dir)).filter((f) => f !== "blueprint.json").sort();
    assert.deepEqual(Object.keys(files).sort(), srcFiles, "Dateimenge im Snapshot != Quelle");
    for (const f of srcFiles) {
      assert.equal(files[f], await readFile(join(dir, f), "utf8"), `${f} weicht ab`);
    }

    // --- Gadget-Code nutzt den agentSpawner tatsächlich ---
    assert.match(files["server.js"], /env\.WORKFLOW\.spawn\(/, "server.js ruft env.WORKFLOW.spawn nicht");

    // --- Sidecar-Regeln (Spiegel von build-format-blueprints.mjs) ---
    assert.equal(sidecar.blueprintId, manifest.blueprintId);
    assert.match(sidecar.blueprintId, /^[a-zA-Z0-9._-]+$/);
    assert.ok(sidecar.title && sidecar.description, "title/description erforderlich");
    assert.ok(Number.isInteger(sidecar.revision) && sidecar.revision >= 1, "revision >= 1");
    assert.ok(OUTPUT_ICONS.includes(sidecar.output.icon), `icon ${sidecar.output.icon} unbekannt`);
    assert.ok(sidecar.output.id && sidecar.output.noun && sidecar.output.plural, "output vollständig");

    // --- Bindings: agentSpawner + spawnerOnly-Gatekeeper, env verweist nur auf Deklariertes ---
    const bindings = metadata.bindings;
    assert.deepEqual(bindings, manifest.bindings, "Archiv-Bindings != Manifest");
    const spawners = Object.entries(bindings).filter(([, b]: any) => b.type === "agentSpawner");
    assert.equal(spawners.length, 1, "genau ein agentSpawner-Binding erwartet");
    const [, spawner]: any = spawners[0];
    for (const [envName, target] of Object.entries(spawner.env) as any) {
      assert.equal(target.type, "binding", `env.${envName}: nur binding-Targets unterstützt`);
      const ref = bindings[target.name];
      assert.ok(ref, `env.${envName} verweist auf unbekanntes Binding ${target.name}`);
      assert.equal(ref.type, "gatekeeper", `${target.name} muss ein gatekeeper sein`);
      assert.equal(ref.spawnerOnly, true, `${target.name} sollte spawnerOnly sein`);
      assert.ok(ref.gatekeeperName, `${target.name} braucht einen gatekeeperName`);
    }
  });
}
