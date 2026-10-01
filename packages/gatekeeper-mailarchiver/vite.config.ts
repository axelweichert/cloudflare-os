// Vite+ per-package settings. Shared by all gatekeepers with a configurator UI; this package's tests
// run under `node --test` (see package.json), so it re-exports the plain config without a test task.
export { default } from "../../scripts/gatekeeper-configurator-vite-config.js";
