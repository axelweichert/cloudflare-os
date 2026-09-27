// One-off live wiring for GATEKEEPER_M365 via inherit-PATCH (no clobber). See memory
// [[gatekeeper-wiring-inherit-patch]]. Router gets the binding WITHOUT entrypoint (fetch proxy);
// backend gets it WITH entrypoint GatekeeperVendor. All existing bindings are inherited verbatim.
const ACCT = "6b9b3fa0e9f6be87faf7ca1b212641a3";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SERVICE = "cloudflareos-gk-m365";
const NEW_BINDING = "GATEKEEPER_M365";
if (!TOKEN) throw new Error("CLOUDFLARE_API_TOKEN not set");

const base = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts`;
const h = { Authorization: `Bearer ${TOKEN}` };

async function getSettings(script) {
  const r = await fetch(`${base}/${script}/settings`, { headers: h });
  const j = await r.json();
  if (!j.success) throw new Error(`GET ${script} settings: ${JSON.stringify(j.errors)}`);
  return j.result;
}

async function patchSettings(script, withEntrypoint) {
  const cur = await getSettings(script);
  const bindings = cur.bindings ?? [];
  const names = bindings.map((b) => b.name);
  const hasM365 = names.includes(NEW_BINDING);
  // Inherit every existing binding verbatim, except drop any prior GATEKEEPER_M365 so we can
  // re-add it fully specified (idempotent re-run).
  const inherited = bindings
    .filter((b) => b.name !== NEW_BINDING)
    .map((b) => ({ type: "inherit", name: b.name }));
  const newBinding = withEntrypoint
    ? { type: "service", name: NEW_BINDING, service: SERVICE, entrypoint: "GatekeeperVendor" }
    : { type: "service", name: NEW_BINDING, service: SERVICE };
  const settings = { bindings: [...inherited, newBinding] };

  const form = new FormData();
  form.append("settings", new Blob([JSON.stringify(settings)], { type: "application/json" }), "settings.json");
  const r = await fetch(`${base}/${script}/settings`, { method: "PATCH", headers: h, body: form });
  const j = await r.json();
  if (!j.success) throw new Error(`PATCH ${script}: ${JSON.stringify(j.errors)}`);
  const after = (j.result.bindings ?? []).map((b) => b.name);
  const m365 = (j.result.bindings ?? []).find((b) => b.name === NEW_BINDING);
  console.log(`${script}: ${bindings.length} -> ${after.length} bindings (had M365=${hasM365}); ` +
    `M365=${JSON.stringify(m365)}; ASSETS=${after.includes("ASSETS")}; ADMINS=${after.includes("ADMINS")}`);
  return after;
}

console.log("== router (cloudflareos) ==");
await patchSettings("cloudflareos", false);
console.log("== backend (cloudflareos-backend) ==");
await patchSettings("cloudflareos-backend", true);
console.log("done");
