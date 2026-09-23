// Post-build guard (OWL-1620): fail if the dev backend fallback `localhost:8787`
// (main.tsx getBackendHost dev branch) leaked into the built assets. A prod bundle
// never contains it; a dev bundle does, and shipping one as the router's ASSETS is
// the OWL-1619 regression (endless spinner -> wss://localhost:8787). Runs as a plain
// `node` command because vp's task runner doesn't parse shell control structures.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'dist/assets'
const NEEDLE = 'localhost:8787'
const hits = []
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (readFileSync(p, 'utf8').includes(NEEDLE)) hits.push(p)
  }
}
walk(dir)

if (hits.length) {
  console.error(
    `GUARD FAIL: dev build detected -- "${NEEDLE}" leaked into ${hits.join(', ')}. ` +
      `Refusing to ship. Build with NODE_ENV=production.`,
  )
  process.exit(1)
}
