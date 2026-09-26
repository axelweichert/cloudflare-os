# gatekeeper-unifi

A Cloudflare OS gatekeeper for **UniFi Site Manager** (Ubiquiti's cloud control plane,
`https://unifi.ui.com`). It gives gadgets and agents **read-only** access to a UniFi account's
consoles, sites, and adopted devices via the [Site Manager API](https://developer.ui.com)
(`https://api.ui.com`).

## Connect flow

Modeled 1:1 on `gatekeeper-homeassistant`: a URL + token style connect flow with **no OAuth**.

1. The user clicks **Connect** on the UniFi connector. `GatekeeperVendor.connectAccount` mints a
   `UserAccount` Durable Object and returns a one-time URL `…/gatekeeper/unifi/<doId>/<nonce>`.
2. The user opens that URL and pastes a **UniFi Site Manager API key**. Create one at
   **unifi.ui.com → Settings → Control Plane → Integrations (API)**.
3. The worker validates the key with a cheap `GET /v1/hosts` call, stores it in the DO's encrypted
   KV storage, and calls back `complete()`. The key is **never** logged, echoed, or committed.

Reconnect (`reconnect()`) reuses the same form to replace an expired key. `revoke()` deletes the DO
and its stored key.

## Access

- **Auth:** account API key in the `X-API-KEY` header. No tunnel, no VPN, no Zero Trust / Access
  changes (that was the mistake in OWL-1559).
- **Base URL:** `https://api.ui.com`.
- **Scope:** whole-account, **read-only**. One grantable resource ("UniFi Account") covering:
  - `listHosts()` / `getHost(id)` — consoles (Dream Machines, Cloud Gateways, CloudKeys…).
  - `listSites()` — sites across every console.
  - `listDevices(hostId?)` — adopted devices, grouped by host.

Every read is authorized through the standard approval queue as an **observation** before any data
is returned to the gadget.

### Why read-only (v1)

The Site Manager cloud API is read-first. It exposes a few mutating SD-WAN endpoints, but nothing
this connector needs today, so v1 issues **no writes** and submits no actions — `applyAction` /
`revertAction` exist to satisfy the `Gatekeeper` interface and throw if ever called. Adding narrowly
scoped write actions later follows the `gatekeeper-homeassistant` `approvals.ts` pattern (submit →
approval queue → apply/revert).

### Not covered

- **Per-client listing.** The Site Manager *cloud* API does not expose per-site client lists; that
  lives in the local Network controller API, which this cloud connector deliberately does not reach.
  If per-client visibility is needed, it is a separate connector against the local controller.
- **Per-site scoping.** v1 grants the whole account. Per-site grantable resources are a natural next
  granularity (add a site-picker configurator + `getGatekeeperClassFor` cases, like Home Assistant's
  area/device/entity resources).

## Account boundary (hard rule)

Only **our own** Cloudflare account and the account owner's **own UniFi** may ever be touched. The
von-Busch Cloudflare account and its repos are off-limits; a `wrangler deploy` must have its
`account_id` checked first. **No deploy is required** for this package's Definition of Done.

## Layout

| File | Purpose |
| --- | --- |
| `src/unifi.ts` | Worker: connect flow, `GatekeeperVendor`, `UserAccount` DO, `UnifiUserImpl`, `UnifiGatekeeperImpl`, read-only session. |
| `src/unifi-api.ts` | Site Manager API client (`X-API-KEY`, pagination, timeouts, error scrubbing). |
| `src/types.d.ts` / `src/types.txt` | Agent-facing session types (`.d.ts` for `tsc`, `.txt` imported as the runtime string). |
| `src/configurator/` | The whole-account confirmation configurator UI. |
