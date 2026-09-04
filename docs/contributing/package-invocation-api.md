# External package invocation API

Inbound [webhooks](../use/webhooks.md) are the advertised external HTTP knock
(`inputMode: "params"`, `Idempotency-Key`, minted URL, no Bearer). This page
documents the unadvertised invocation-token drain that leftover callers still
hit.

A stable webhook proxy is a representative leftover caller:

1. the external proxy owns the provider-specific connection or webhook ingress
2. the proxy normalizes inbound events
3. the proxy calls this drain
4. Kody executes the saved package export with package context, user context,
   package storage, and normal secret/capability rules

Kody is the package runtime and storage brain. The external service owns the
provider lifecycle. New first-party callers mint a webhook URL instead.

## Endpoint

`POST /@:username/api/package-invocations/:kodyId/:exportName`

Examples:

- `/@alice/api/package-invocations/webhook-dispatcher/dispatch-event`

The path uses the owner's username and the package `kody.id`.

The export name is normalized to package export form, so `dispatch-event`
resolves as `./dispatch-event`.

## Authentication

Authentication uses a private bearer token stored in Kody's database-backed
package invocation token table.

Kody stores only the token hash for request-time lookup. The raw bearer token is
sent by the leftover external service as:

```http
Authorization: Bearer <raw-token>
```

Each token belongs to exactly one saved package. Auth resolves the owner and
package from the URL, then looks up `(user_id, package_id, token_hash)`.

Each token row includes:

- token id and human-readable name
- owning `user_id` and `package_id`
- allowed package exports (`export_names_json`)
- `last_used_at`
- `revoked_at`

The token is not a global backdoor:

- the path names the owner and package
- the bearer proves access to that package only
- export access requires an explicit allowlist (including per-package `*`)
- request JSON `source` is an optional log label and does not gate auth
- tokens can be revoked without deploys
- execution uses normal package runtime machinery
- `last_used_at` is a best-effort write and does not gate authentication

### Operator drain

Token list/create/rotate/revoke/delete stay on the same-origin JSON endpoint as
an unadvertised operator drain. They are not in account navigation, package
settings, or MCP search.

- `GET /account/packages.json` — list packages; include `selected=<packageId>`
  to load that package's token metadata
- `POST /account/packages.json` with `action: "create-token"` — create a token
  for one owned package
- `POST /account/packages.json` with `action: "update-token"` — update token
  name, export allowlist, and optionally replace the stored token hash from a
  new raw token
- `POST /account/packages.json` with `action: "revoke-token"` — revoke a token
  by id
- `POST /account/packages.json` with `action: "reinstate-token"` — reinstate a
  revoked token by id
- `POST /account/packages.json` with `action: "delete-token"` — permanently
  delete a token row by id

Create payload shape:

```json
{
	"action": "create-token",
	"packageId": "<saved-package-id>",
	"name": "Trusted external client",
	"rawToken": "<raw-token>",
	"exportNames": ["*"]
}
```

Export allowlists support the deliberate wildcard value `*` for every export on
that package. Token list/detail payloads never return the raw token or token
hash.

`packageInvocationTokenList` and `packageInvocationTokenGet` stay callable by
exact capability name as the same unadvertised drain. Search, domain listings,
and `packageGet` do not advertise tokens.

## Request body

```json
{
	"params": {
		"eventId": "123",
		"content": "hello"
	},
	"idempotencyKey": "webhook:event:123",
	"source": "webhook-dispatcher",
	"topic": "webhook.event"
}
```

Fields:

- `params` — JSON object passed as the first argument to the package export
- `idempotencyKey` — required stable key for replay protection
- `source` — optional caller label for logs. It does not gate authentication or
  determine idempotency.
- `topic` — optional event topic label for downstream logic and logs

## Idempotency

Kody persists package invocation idempotency in D1.

The identity key is:

- user
- token id
- package id
- export name
- idempotency key

Behavior:

- same request + same idempotency key => stored response replayed
- same idempotency key + different payload => `409 idempotency_mismatch`
- duplicate while first invocation is still active =>
  `409 invocation_in_progress`

This makes duplicate event deliveries safe when the proxy retries.

## Response shape

Success:

```json
{
	"ok": true,
	"package": {
		"id": "pkg_123",
		"kodyId": "webhook-dispatcher"
	},
	"exportName": "./dispatch-event",
	"source": "webhook-dispatcher",
	"topic": "webhook.event",
	"idempotency": {
		"key": "webhook:event:123",
		"replayed": false
	},
	"result": {
		"reply": "handled"
	},
	"logs": []
}
```

Replay responses return the same stored body with `idempotency.replayed: true`.

Failures return:

```json
{
	"ok": false,
	"error": {
		"code": "package_not_found",
		"message": "Saved package \"webhook-dispatcher\" was not found for this user."
	}
}
```

Execution failures return sanitized structured errors and logs. The route does
not expose Worker secrets directly.

## Runtime behavior

The API reuses the existing published package bundle path:

- resolve the saved package for the configured user
- resolve the requested package export
- load the published `module` artifact if present
- rebuild and persist the module artifact on cache miss
- execute through `runBundledModuleWithRegistry`

Execution includes:

- package context
- repo context when a published source exists
- writable package storage bound to `package:{encodeURIComponent(packageId)}`
  (`packageStorage()`)
- user context from the scoped token config

## Rate limiting and auditing

The endpoint is shaped for standard Cloudflare edge rate limiting:

- path is stable and narrow
- caller metadata includes `source` and `topic`
- each request is audit-logged with hashed email/IP metadata

Prefer Cloudflare WAF/rate limiting rules in front of this path rather than
adding bespoke in-Worker rate limiting first.

## Leftover caller pattern

Existing drain callers `POST` with `Authorization: Bearer` and a stable
`idempotencyKey`:

```bash
curl --fail --silent \
	-X POST \
	-H "Authorization: Bearer $PACKAGE_INVOCATION_TOKEN" \
	-H "Content-Type: application/json" \
	"https://kody.example.com/@alice/api/package-invocations/webhook-dispatcher/dispatch-event" \
	-d '{
		"params": {
			"eventId": "123",
			"resourceId": "456",
			"content": "hello"
		},
		"idempotencyKey": "webhook:event:123",
		"source": "webhook-dispatcher",
		"topic": "webhook.event"
	}'
```

New first-party callers declare one webhook per export (`inputMode: "params"`),
mint a URL with `webhookUrlMint`, and send `Idempotency-Key`. There is no `*`
webhook. See [Inbound webhooks](../use/webhooks.md).

## Related

- [Inbound webhooks](../use/webhooks.md)
- [Invocation-token retirement runbook](./architecture/invocation-token-retirement-runbook.md)
- [Packages and manifests](./packages-and-manifests.md)
- [Environment variables](./environment-variables.md)
- [Setup manifest](./setup-manifest.md)
