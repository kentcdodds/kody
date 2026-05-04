# External package invocation API

Use this API when a trusted external service should invoke a saved package
export inside Kody without going through the interactive MCP transport.

The first intended caller is a stable Discord Gateway proxy:

1. the external proxy owns the long-lived Discord websocket
2. the proxy normalizes gateway events
3. the proxy calls Kody's package invocation API
4. Kody executes the saved package export with package context, user context,
   package storage, and normal secret/capability rules

Kody is the package runtime and storage brain. The external service owns the
socket lifecycle.

## Endpoint

`POST /api/package-invocations/:packageIdOrKodyId/:exportName`

Examples:

- `/api/package-invocations/pkg_123/dispatch-message-created`
- `/api/package-invocations/discord-gateway/dispatch-message-created`

The path accepts either:

- the saved package id
- the package `kody.id`

The export name is normalized to package export form, so
`dispatch-message-created` resolves as `./dispatch-message-created`.

## Authentication

Authentication uses a private bearer token stored in Kody's database-backed
package invocation token table.

Kody stores only the token hash for request-time lookup. The raw bearer token is
generated or collected by the token-management surface, shown to the operator
once, and then sent by the trusted external service as:

```http
Authorization: Bearer <raw-token>
```

Each token row includes:

- token id and human-readable name
- owning `user_id`, `email`, and `display_name`
- package scope (`package_ids_json` and/or `package_kody_ids_json`)
- allowed package exports (`export_names_json`)
- allowed request sources (`sources_json`)
- `last_used_at`
- `revoked_at`

The token is not a global backdoor:

- package lookup is user-owned
- package access is scoped by the token row
- export access requires an explicit allowlist
- `source` metadata is checked against the allowlist when provided
- tokens can be revoked without deploys
- execution uses normal package runtime machinery

## Request body

```json
{
	"params": {
		"messageId": "123",
		"content": "hello"
	},
	"idempotencyKey": "discord:message-create:123",
	"source": "discord-gateway",
	"topic": "discord.message.created"
}
```

Fields:

- `params` — JSON object passed to the package export as runtime params
- `idempotencyKey` — required stable key for replay protection
- `source` — optional source label for auditing and token scoping; when present,
  it must match the token's `sources_json` allowlist
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

This makes duplicate Discord gateway deliveries safe when the proxy retries.

## Response shape

Success:

```json
{
	"ok": true,
	"package": {
		"id": "pkg_123",
		"kodyId": "discord-gateway"
	},
	"exportName": "./dispatch-message-created",
	"source": "discord-gateway",
	"topic": "discord.message.created",
	"idempotency": {
		"key": "discord:message-create:123",
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
		"message": "Saved package \"discord-gateway\" was not found for this user."
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
- writable package storage bound to `package:<packageId>`
- user context from the scoped token config

## Rate limiting and auditing

The endpoint is shaped for standard Cloudflare edge rate limiting:

- path is stable and narrow
- caller metadata includes `source` and `topic`
- each request is audit-logged with hashed email/IP metadata

Prefer Cloudflare WAF/rate limiting rules in front of this path rather than
adding bespoke in-Worker rate limiting first.

## Discord gateway proxy pattern

Recommended flow:

1. keep the Discord Gateway websocket in a stable external process
2. receive `MESSAGE_CREATE`
3. derive a stable idempotency key from the gateway event
4. call the Kody endpoint
5. use Kody's structured result to decide what to post back to Discord

Example request:

```bash
curl --fail --silent \
	-X POST \
	-H "Authorization: Bearer $PACKAGE_INVOCATION_TOKEN" \
	-H "Content-Type: application/json" \
	"https://kody.example.com/api/package-invocations/discord-gateway/dispatch-message-created" \
	-d '{
		"params": {
			"messageId": "123",
			"channelId": "456",
			"content": "hello"
		},
		"idempotencyKey": "discord:message-create:123",
		"source": "discord-gateway",
		"topic": "discord.message.created"
	}'
```

## Related

- [Packages and manifests](./packages-and-manifests.md)
- [Environment variables](./environment-variables.md)
- [Setup manifest](./setup-manifest.md)
