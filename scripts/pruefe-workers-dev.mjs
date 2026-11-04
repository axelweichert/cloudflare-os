#!/usr/bin/env node
// Prüft, dass jede Wrangler-Konfiguration im Repo die workers.dev-Adresse und die
// Vorschau-Adressen abschaltet: `workers_dev = false` und `preview_urls = false`,
// oben in der Datei und in jedem `env.*`-Block. Fehlt eins davon, bricht das Skript
// mit Exit-Code 1 ab – sonst würde der nächste `wrangler deploy` die Adresse wieder
// öffnen (Wrangler-Standard ist `true`). Board-Auftrag OWL-2360, 04.11.2026.
//
// Aufruf: node scripts/pruefe-workers-dev.mjs [Datei|Verzeichnis ...]
// Ohne Argument wird das ganze Repo durchsucht. Keine Abhängigkeiten.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const KEYS = ["workers_dev", "preview_urls"];
const SKIP = new Set(["node_modules", ".git", ".wrangler", "dist", "build", ".open-next", ".astro", ".svelte-kit", ".output", ".next", "graphify-out"]);
const NAME = /^wrangler(\.[\w-]+)?\.(toml|jsonc?)$/;

function find(path, out) {
  const st = statSync(path);
  if (st.isFile()) {
    out.push(path);
    return out;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) find(join(path, entry.name), out);
    } else if (NAME.test(entry.name)) {
      out.push(join(path, entry.name));
    }
  }
  return out;
}

// JSONC → JSON: Kommentare und hängende Kommas entfernen, Strings unangetastet lassen.
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Minimal-TOML: nur die Schlüssel, die hier zählen – oben in der Datei und direkt in [env.<name>].
function parseToml(text) {
  const top = {};
  const env = {};
  let section = top;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      const m = !line.startsWith("[[") && header[1].match(/^env\.("?)([^".]+)\1$/);
      section = m ? (env[m[2]] ??= {}) : null;
      if (header[1].startsWith("env.") && !m) {
        const name = header[1].split(".")[1].replace(/"/g, "");
        env[name] ??= {};
      }
      continue;
    }
    const kv = line.match(/^("?)([\w.-]+)\1\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, , key, value] = kv;
    const v = value.trim() === "false" ? false : value.trim() === "true" ? true : value.trim();
    const dotted = key.match(/^env\.([^.]+)\.(\w+)$/);
    if (dotted && section === top) (env[dotted[1]] ??= {})[dotted[2]] = v;
    else if (section) section[key] = v;
  }
  return { ...top, env };
}

function check(file) {
  const text = readFileSync(file, "utf8");
  const config = file.endsWith(".toml") ? parseToml(text) : parseJsonc(text);
  // Pages-Projekte kennen den Schalter nicht (Wrangler lehnt die Schlüssel dort ab).
  if (config.pages_build_output_dir) return null;
  const errors = [];
  const blocks = [["oben", config], ...Object.entries(config.env ?? {}).map(([n, b]) => [`env.${n}`, b])];
  for (const [where, block] of blocks) {
    for (const key of KEYS) {
      if (block[key] !== false) errors.push(`${where}: ${key} = false fehlt (gefunden: ${block[key] ?? "nichts"})`);
    }
  }
  return errors;
}

const roots = process.argv.slice(2);
const files = (roots.length ? roots : ["."]).flatMap((r) => find(r, []));
let failed = 0;
for (const file of files) {
  let errors;
  try {
    errors = check(file);
  } catch (e) {
    errors = [`nicht lesbar: ${e.message}`];
  }
  const name = relative(".", file) || file;
  if (errors === null) {
    console.log(`– ${name} (Pages, übersprungen)`);
  } else if (errors.length) {
    failed++;
    for (const e of errors) console.error(`✗ ${name} – ${e}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
if (!files.length) console.log("Keine Wrangler-Konfiguration gefunden.");
if (failed) {
  console.error(`\n${failed} Wrangler-Konfiguration(en) lassen workers.dev oder Vorschau-Adressen offen. Siehe OWL-2360.`);
  process.exit(1);
}
