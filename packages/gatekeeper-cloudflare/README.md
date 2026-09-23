# Gatekeeper Cloudflare

This package connects a Cloudflare account by **pasting an API token** (the same proven flow as
`gatekeeper-unifi`), not by OAuth redirect. Cloudflare's self-managed OAuth does not expose the AI
Gateway scopes this integration needs in its consent catalog, but the same capability exists as
API-token permissions (see [Setup](#setting-up-the-api-token)). It serves two purposes:

- **AI Gateway billing:** the Workshop reads a usable token from the connection
  (`getUsableAccessToken`) to power the [AI Gateway billing](../../docs/ai-gateway-billing.md) flow —
  reading the credit balance and routing BYOK inference through the account's default AI Gateway.
- **Workers Observability:** gadgets can receive read-only access to logs, events, invocations,
  aggregate metrics, and traces either across an account or restricted to one Worker. Every result
  is authorized as an observation, and Worker bindings inject an immutable service filter and
  defensively discard foreign-service events. Distributed trace summaries are account-only because
  their names, timing, services, and counts describe the whole cross-service trace; a Worker binding
  can still retrieve its own events for a known trace ID.

A pasted API token carries all of its permissions up-front, so every supported resource (account and
Worker observability) is grantable as soon as the account is connected — there is no incremental
consent step. Cloudflare exposes account and Worker resource choices, but both are read via the one
token; resource bindings provide the finer capability boundary after connection.

Workers telemetry is retained by Cloudflare for at most seven days. Queries default to the last hour,
and the Worker picker searches the full retention window. Suggested bindings are
`CLOUDFLARE_OBSERVABILITY` for account access and `WORKER_OBSERVABILITY` for one Worker.

### Sharing a gadget that reads telemetry

A binding is not transferable. When a gadget with an observability binding is shared, each
collaborator is admitted only if **their own** connected Cloudflare account can read that resource
(`addObserver` checks it against their credentials, not the owner's). A collaborator without access is
refused, and a verification that fails for any other reason — a 5xx, a transport error — is also a
refusal rather than an admission.

### What a Worker binding trusts, and what it re-checks

The scope filter is prepended to every query, but a filter the provider *accepted* is not evidence it
*applied* it — three separate behaviours here return wrong-but-plausible data with no error. So events
are re-filtered on the way out, and a single foreign event is treated as proof the filter was dropped:
the provider's `count` is withheld (it would be a count of the whole account's matching telemetry) and
the event is logged at `error`. `statistics` is kept, because it describes what our query cost rather
than how much matched, and callers are told to read it for cost.

The re-check is deliberately not a hard failure. The events returned are filtered and therefore safe,
and this provider has surprised us often enough that turning a hypothetical disclosure into a
guaranteed outage would be the worse trade.

`calculate()` is the exception, and knowingly so: an aggregate cannot be un-mixed, so there is no
second line of defence to add. It rests entirely on the injected filter. The fix that would work —
grouping by `$metadata.service` and keeping this binding's own group, whose value *is* the correctly
scoped answer even for a median — changes `limit` and `orderBy` semantics for every caller, so it is a
follow-up rather than a footnote.

### Why discovery sometimes costs a query

Cloudflare's `telemetry/keys` and `telemetry/values` endpoints ignore the `filters` array they accept:
verified against a live account, they answer for the whole account no matter what is passed. A
Worker-scoped binding therefore cannot use them — they would disclose every field name and value in
the account. Whenever a discovery call has to be constrained (a Worker binding, or any caller-supplied
filter), the answer is derived instead from a filtered `telemetry/query` events sample, which the
provider does filter correctly. Unconstrained account-wide discovery still uses the cheap endpoints.

> Unresolved: whether the `workers-observability.read` scope alone is accepted, or whether Cloudflare
> requires the Workers Observability **Write** permission to read telemetry. This has not been
> verified against a live token; if reads 403 on a correctly-scoped grant, that is the first thing to
> check.

### Two names for one field

A log's own structured fields are returned nested under `source` but are **indexed under their bare
name**: `logger.warn(msg, {event: "x"})` comes back as `source.event` and is queried as `event`.
Confirmed both ways — `telemetry/keys` on a live account reports `event`/`component`/`level` and no
`source.*` key at all, and the [Workers Logs
docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) show
`console.log({user_id: 123})` being filtered as `user_id`.

This matters because the provider accepts an unknown filter key, matches nothing, and returns an empty
page with no error. So discovery reports indexed names (`observability-discovery.ts`), and
`observabilityFieldKey` additionally accepts a `source.`-prefixed key as an alias wherever a caller
names a field — filters, `calculations`, `groupBys`, `listValues` — because copying a path out of a
`listEvents` result is the obvious thing to do and used to fail silently.

Identity comes from `/accounts`, not `/user`: an API token cannot read `/user`, so the connected
account's display name is derived from the account(s) the token can see (one account → its name;
several → a count), exactly as `gatekeeper-unifi` names the console.

### Why an error's text never reaches the log

`summarizeFilter` deliberately keeps filter *values* out of the audit trail — they are caller text.
But a provider error message can quote that same value straight back, so logging the message would
readmit through the error path exactly what the audit path excludes. `CloudflareObservabilityApiError`
therefore carries Cloudflare's numeric `codes` alongside the message: the request log names the
codes, and the message travels only to the caller who caused it.

The codes are not the discriminator, though — Cloudflare can return a message with no numeric code
at all, so the error records separately whether the message is *its* or *ours*, and only ours is
logged. A provider failure carrying no codes is therefore logged as a bare status, which is the
fail-closed answer: the status still says what happened without quoting anyone's filter back.

### Listing accounts is a walk, not a request

`/accounts` is paginated and defaults to **20** per page, so a single GET silently returns a truncated
list — an account past the first page simply cannot be picked, with nothing to indicate why. The
account picker's substring match also stays client-side: `name` is the only documented server-side
filter and whether it matches exactly or by substring is not specified, so pushing it down would trade
a visible truncation for an invisible one.

## Setting Up the API Token

There is **no deployment-side configuration** — no OAuth client, no `CLIENT_ID`/`CLIENT_SECRET`, no
registered redirect URI. Each user pastes their own Cloudflare API token into the connect form. The
token is validated against `GET /user/tokens/verify` and stored encrypted in the connection's Durable
Object.

Create the token in the Cloudflare dashboard under **My Profile → API Tokens → Create Custom Token**
with these permissions:

| Resource | Permission |
| --- | --- |
| Account → AI Gateway | Read |
| Account → AI Gateway | Run |
| Account → Account Settings | Read |
| Account → Workers Observability | Read |

Scope it to the account(s) you want to expose. `Account Settings → Read` is what lets the connector
enumerate accounts (for the display name and the AI Gateway billing account selection); the AI
Gateway and Workers Observability permissions back the two purposes above.

### Verify Setup

1. Start the application in dev mode (see the root README.md), or use the live deployment.
2. Open the **Cloudflare** gatekeeper tile and click **Connect**.
3. The connect form opens (no OAuth redirect); paste your API token and submit.
4. On success the tab closes and the tile is active. If the token is invalid the form re-renders with
   an error and no state is stored.

## Troubleshooting

### "Cloudflare rejected the API token"

`GET /user/tokens/verify` did not report the token as `active`. Confirm the token is enabled and
copied correctly, then resubmit — the connect link stays valid until the nonce expires.

### The tile activates but observability reads return 403

The token is valid but missing a permission. Re-create it with all four permissions in the table
above (in particular **Workers Observability → Read**) and reconnect.
