// Vite+ per-package settings. `withTests` is the shared configurator config plus the shared vitest
// `test` task. Shared by all gatekeepers with a configurator UI and living beside the builder it runs.
export { withTests as default } from '../../scripts/gatekeeper-configurator-vite-config.js'
