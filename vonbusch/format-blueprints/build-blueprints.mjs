// Baut die von-Busch-Firmen-Workflow-Blueprints aus lesbarem Quellcode in `.gadget`-Archive +
// `.json`-Sidecars — genau das Paar, das `packages/workshop-backend/scripts/build-format-blueprints.mjs`
// erwartet, wenn man ihn mit FORMAT_BLUEPRINTS_DIR auf DIESES Verzeichnis zeigt.
//
// Warum überhaupt ein eigener Builder? Ein `.gadget`-Archiv ist binär (24-Byte-Prefix + JSON-
// Metadaten + gzip(Yjs-V2-Snapshot), siehe packages/workshop-backend/src/blueprint-archive.ts).
// Der Upstream-Weg wäre "in einer laufenden Workshop bauen, exportieren, importieren". Für
// versionierbare, reviewbare Firmen-Blueprints wollen wir stattdessen den Gadget-Quellcode im
// Repo halten und das Archiv daraus deterministisch erzeugen.
//
// Quelle: src/<name>/ mit blueprint.json (Metadaten + Bindings + Sidecar) und den Gadget-Dateien
// (alles außer blueprint.json). Ausgabe: <name>.gadget + <name>.json neben dieser Datei.
//
// Deterministisch: feste Timestamps aus blueprint.json, compare-before-write, damit ein erneuter
// Lauf ohne Quelländerung keine Bytes (und damit keine Revision) anfasst.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// yjs lebt in den node_modules von workshop-backend (pnpm hebt nicht auf den Repo-Root); von dort
// auflösen statt einen tiefen .pnpm-Pfad hart zu verdrahten.
const require = createRequire(join(here, "..", "..", "packages", "workshop-backend", "package.json"));
const Y = require("yjs");

// Muss mit src/blueprint-archive.ts übereinstimmen.
const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;
const textEncoder = new TextEncoder();

function encodeArchive(metadata, content) {
  const metaBytes = textEncoder.encode(JSON.stringify(metadata));
  const out = new Uint8Array(PREFIX_BYTES + metaBytes.byteLength + content.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, MAGIC);
  view.setUint32(8, VERSION);
  view.setUint32(12, metaBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  out.set(metaBytes, PREFIX_BYTES);
  out.set(content, PREFIX_BYTES + metaBytes.byteLength);
  return out;
}

// Gadget-Snapshot: Yjs-Doc, dessen unbenannte Root-Map filename -> Y.Text ist (siehe
// blueprint-archive.ts / multi-gadget.md), V2-kodiert und gzip-komprimiert.
function encodeContent(files) {
  const doc = new Y.Doc();
  // Yjs vergibt sonst pro Doc eine zufällige clientID -> nicht-deterministische Bytes. Fest
  // verdrahten, damit ein Rebuild ohne Quelländerung dieselben Archiv-Bytes erzeugt.
  doc.clientID = 1;
  const root = doc.getMap();
  for (const name of Object.keys(files).sort()) {
    const text = new Y.Text();
    text.insert(0, files[name]);
    root.set(name, text);
  }
  const update = Y.encodeStateAsUpdateV2(doc);
  return new Uint8Array(gzipSync(Buffer.from(update)));
}

async function writeIfChanged(path, bytes) {
  let same = false;
  try {
    const existing = new Uint8Array(await readFile(path));
    same = existing.byteLength === bytes.byteLength && Buffer.from(existing).equals(Buffer.from(bytes));
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (same) return false;
  await writeFile(path, bytes);
  return true;
}

const srcDir = join(here, "src");
const dirs = (await readdir(srcDir, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

let built = 0;
for (const name of dirs) {
  const dir = join(srcDir, name);
  const manifest = JSON.parse(await readFile(join(dir, "blueprint.json"), "utf8"));
  const { blueprintId, version, created, sidecar, bindings } = manifest;

  const files = {};
  for (const f of (await readdir(dir)).sort()) {
    if (f === "blueprint.json") continue;
    files[f] = await readFile(join(dir, f), "utf8");
  }

  // Archiv-Metadaten: title/description/author/output werden beim Install ohnehin vom Sidecar
  // überschrieben, aber wir halten sie hier konsistent, damit die committeten Bytes dem Sidecar
  // nicht widersprechen. created/lastUpdated sind fix -> deterministisch.
  const metadata = {
    title: sidecar.title,
    description: sidecar.description,
    author: sidecar.author,
    created,
    version,
    lastUpdated: created,
    output: sidecar.output,
    bindings,
  };

  const archive = encodeArchive(metadata, encodeContent(files));
  const sidecarOut = {
    $comment: "GENERIERT aus src/" + name + "/blueprint.json durch build-blueprints.mjs — dort editieren, nicht hier.",
    blueprintId,
    title: sidecar.title,
    description: sidecar.description,
    output: sidecar.output,
    author: sidecar.author,
    revision: sidecar.revision,
  };

  const a = await writeIfChanged(join(here, `${name}.gadget`), archive);
  const s = await writeIfChanged(
    join(here, `${name}.json`),
    textEncoder.encode(JSON.stringify(sidecarOut, null, 2) + "\n"),
  );
  built++;
  const bindingList = Object.entries(bindings)
    .map(([k, v]) => `${k}:${v.type}${v.spawnerOnly ? "(spawnerOnly)" : ""}`).join(", ");
  console.log(`${name}  (${blueprintId})  ${(archive.byteLength / 1024).toFixed(1)} KiB` +
    `${a || s ? "  [geschrieben]" : "  [unverändert]"}\n    bindings: ${bindingList}`);
}

console.log(`\n${built} Blueprint(s) gebaut. Bundle mit:\n` +
  `  cd packages/workshop-backend && FORMAT_BLUEPRINTS_DIR=../../vonbusch/format-blueprints \\\n` +
  `    node scripts/build-format-blueprints.mjs`);
