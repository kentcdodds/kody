# Account package invocation token setup guide

Use the hosted **`/account/package-invocation-tokens/new`** page when an
external trusted client needs to call Kody package exports through the package
invocation HTTP API. The agent may construct a prefilled setup URL, but the
agent must never see, generate for chat, or place the raw bearer token in the
URL.

For package runtime code that runs inside Kody, prefer `packages.invoke` or
`packages.invokeChecked` instead of bearer tokens. Package invocation tokens are
for external systems such as webhooks, gateway proxies, CLIs, or other trusted
personal clients that call Kody over HTTP.

## When to use `/account/package-invocation-tokens/new`

Use it when:

- a non-Kody process must invoke a saved package export
- the user will store the raw bearer token in that external system
- package access should be scoped to specific packages, exports, and optional
  source labels

Do **not** ask the user to paste bearer tokens into chat. Do **not** include a
`rawToken`, `token`, `bearer`, or token hash query parameter.

Existing token values can be rotated from the account token editor. That field
is write-only and optional: leaving it blank keeps the current bearer value,
while pasting a new raw token replaces the stored hash. The UI never shows the
existing raw token or token hash.

Agents can inspect existing token record metadata with
`package_invocation_token_list` and `package_invocation_token_get`. These
capabilities return record ids, names, package/export/source scopes, timestamps,
last-used metadata, and revocation status for the signed-in user's own records.
They never return raw bearer token values or stored token hashes.

In the editor, look for the **Token value** section. The **New raw token value**
field is where the user pastes or generates a replacement token value before
saving.

When the exact bearer value does not matter, the user can click **Generate** in
the raw-token field. Kody generates a high-entropy browser-side token, fills the
password field, and offers a **Copy** control so the user can paste it into the
external service or secret store. After saving, Kody stores only the hash and
will not show the raw value again.

## URL format

This section is only for token setup. Setup URLs under
`/account/package-invocation-tokens/new` open the browser UI where the signed-in
user creates or rotates a token. They are **not** package invocation URLs and
must not be used by external workers, webhooks, or CLIs as the HTTP API
endpoint.

Provide the user a URL like:

`https://<your-kody-origin>/account/package-invocation-tokens/new?name=Webhook%20Dispatcher&packageKodyIds=webhook-dispatcher&exportNames=dispatch-event&allowedSources=webhook-dispatcher`

Wildcard package/export setup for a highly trusted personal client:

`https://<your-kody-origin>/account/package-invocation-tokens/new?name=Trusted%20External%20Client&packageKodyIds=*&exportNames=*&allowedSources=trusted-client`

## Query params

Repeat params or comma-separate values for list fields. The form also accepts
common snake_case and kebab-case aliases so agents can construct URLs from API
field names without extra translation.

| Param                                       | Required | Description                                                                                         |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`                                      | yes      | Human-readable token name.                                                                          |
| `packageKodyIds` / `packageKodyId`          | yes\*    | Saved package `kody.id` values, or `*` for all packages owned by the signed-in Kody user.           |
| `kodyIds` / `kodyId`                        | yes\*    | Alias for `packageKodyIds`.                                                                         |
| `packageIds` / `packageId`                  | yes\*    | Saved package ids, or `*` for all packages owned by the signed-in Kody user.                        |
| `exportNames` / `exportName`                | yes      | Package export names. `dispatch-event` is normalized to `./dispatch-event`; `*` allows all exports. |
| `allowedSources` / `allowedSource`          | no       | Optional exact source labels the external caller may send in request JSON.                          |
| `sources` / `source`                        | no       | Alias for `allowedSources`.                                                                         |
| `package_kody_ids`, `package-kody-ids`, etc | no       | Snake_case and kebab-case aliases are accepted for the fields above.                                |

\* At least one package scope is required: either a package Kody id scope or a
package id scope.

## Invocation URL format

External callers invoke package exports with the owner-scoped route:

`POST https://heykody.dev/@:username/api/package-invocations/:kodyId/:exportName`

The `@:username` segment is required and must be the public username of the
package owner. Do not use the stale unscoped form
`/api/package-invocations/:kodyId/:exportName`.

Export names are normalized for token scope checks. The URL path usually omits
the leading `./`, so an export scoped as `./process-video` is invoked with the
path segment `process-video`.

Concrete YouTube WebSub Worker example:

```sh
curl -X POST \
	"https://heykody.dev/@kentcdodds/api/package-invocations/youtube-livestream-vod-manager/process-video" \
	-H "Authorization: Bearer <raw-token>" \
	-H "Content-Type: application/json" \
	-d '{
		"idempotencyKey": "youtube:<video-id>",
		"source": "youtube-websub-proxy",
		"params": {
			"videoId": "<video-id>"
		}
	}'
```

When a token is scoped to allowed sources, the request JSON `source` must match
one of those source labels exactly. For Kent's YouTube Worker, use
`"source": "youtube-websub-proxy"`.

Prefer canonical URL metadata from package discovery over manual string
construction. `package_get` and package entity search details include canonical
external invocation metadata with the URL, path, route export name, normalized
export name used for token scope checks, and source guidance for each callable
export.

## Agent instructions

1. Identify the saved package and export the external system needs to call.
   - Use package Kody ids when possible because they are human-readable.
   - Use `*` only for highly trusted personal clients.
2. If debugging an existing setup, call `package_invocation_token_list` or
   `package_invocation_token_get` first to confirm which token record exists and
   whether its package, export, and allowed-source scopes match the external
   caller. Do not ask the user to read token metadata out of the browser UI
   unless the capability response is insufficient.
3. Generate a `/account/package-invocation-tokens/new` URL with `name`, package
   scope, export scope, and optional `allowedSources`.
4. Ask the user to open the URL, paste their locally generated raw token into
   the Raw token field, or click **Generate** and copy/deliver the generated
   value before creating the token.
   - For rotation, ask the user to open the existing token detail URL and paste
     or generate the new raw token in the **Token value** section.
   - The external service or secret store must receive the exact raw value that
     was pasted/generated.
5. Instruct the external caller to send:
   - `POST` to the canonical owner-scoped invocation URL from package metadata,
     not to a `/account/package-invocation-tokens/...` setup URL
   - `Authorization: Bearer <raw-token>`
   - JSON `source` matching one of the allowed sources when sources are scoped
6. Never display, log, store in docs, or send raw token material through chat or
   query params.

## Verification notes for agents

The account token pages are browser-session UI routes. Fetching
`/account/package-invocation-tokens` from MCP `execute` returns an HTML app
shell, not the client-loaded token list, and
`/account/package-invocation-tokens.json` requires the signed-in browser session
cookie. Agents should not treat missing token metadata in the HTML shell as
proof that a token was not saved.

For external invocation smoke tests, check failures in this order:

1. `owner_slug_required`: the endpoint is missing the `@:username` owner slug.
   Use `/@:username/api/package-invocations/:kodyId/:exportName`;
   `/api/package-invocations/...` is not an invocation route.
2. `not_found`: verify the owner slug matches the package owner.
3. `invalid_token` or `Invalid package invocation token`: the request reached
   bearer-token authentication on a correctly shaped owner-scoped endpoint.
   Rotate the package invocation token or check that the external secret
   contains the exact active raw bearer value.

Package export names and `source` policy are checked only after bearer-token
authentication succeeds.

## Related

- [External package invocation API](../contributing/package-invocation-api.md)
- [Packages](../use/packages.md)
