---
id: package_invocation_token_setup
title: Package invocation token setup guide
summary:
  Hosted /account/packages/:packageId?newToken=1 setup URL shape, owner-scoped
  /@:username/api/package-invocations invocation route shape, query params, and
  bearer-token safety policy for external package invocation clients.
category: platform
---

# Package invocation token setup guide

Use the hosted **package details** page when an external trusted client needs to
call one Kody package export through the package invocation HTTP API. The agent
may construct a prefilled setup URL, but the agent must never see, generate for
chat, or place the raw bearer token in the URL.

For code that runs inside Kody, never use bearer tokens: statically import the
target package (`kody:@scope/package/export`) when its name is known when the
code is written, or call `packages.invoke({ kodyId, exportName, params })` when
the call must be dynamic. Package invocation tokens are for external systems
such as webhooks, gateway proxies, CLIs, or other trusted personal clients that
call Kody over HTTP.

## When to use `/account/packages/:packageId?newToken=1`

Use it when:

- a non-Kody process must invoke one saved package export
- the user will store the raw bearer token in that external system
- export access should be scoped to specific exports and optional source labels
  on that package

Do **not** ask the user to paste bearer tokens into chat. Do **not** include a
`rawToken`, `token`, `bearer`, or token hash query parameter.

Existing token values can be rotated from the package's token editor. That field
is write-only and optional: leaving it blank keeps the current bearer value,
while pasting a new raw token replaces the stored hash. The UI never shows the
existing raw token or token hash.

Agents can inspect existing token record metadata with
`package_invocation_token_list` (requires `package_id`),
`package_invocation_token_get`, and `package_get` (includes `tokens`). These
capabilities return record ids, names, the owning package, export/source scopes,
timestamps, last-used metadata, and revocation status for the signed-in user's
own records. They never return raw bearer token values or stored token hashes.

When the exact bearer value does not matter, the user can click **Generate** in
the raw-token field. Kody generates a high-entropy browser-side token, fills the
password field, and offers a **Copy** control so the user can paste it into the
external service or secret store. After saving, Kody stores only the hash and
will not show the raw value again.

## URL format

This section is only for token setup. Setup URLs under
`/account/packages/:packageId?newToken=1` open the browser UI where the
signed-in user creates a token for that package. They are **not** package
invocation URLs and must not be used by external workers, webhooks, or CLIs as
the HTTP API endpoint.

Provide the user a URL like:

`https://<your-kody-origin>/account/packages/<packageId>?newToken=1&name=Webhook%20Dispatcher&exportNames=dispatch-event&allowedSources=webhook-dispatcher`

Wildcard export setup for a highly trusted client of one package:

`https://<your-kody-origin>/account/packages/<packageId>?newToken=1&name=Trusted%20External%20Client&exportNames=*&allowedSources=trusted-client`

## Query params

Repeat params or comma-separate values for list fields. The form also accepts
common snake_case and kebab-case aliases so agents can construct URLs from API
field names without extra translation.

| Param                               | Required | Description                                                                                         |
| ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `newToken`                          | yes      | Set to `1` to open the create form on this package.                                                 |
| `name`                              | no       | Human-readable token name.                                                                          |
| `exportNames` / `exportName`        | no       | Package export names. `dispatch-event` is normalized to `./dispatch-event`; `*` allows all exports. |
| `allowedSources` / `allowedSource`  | no       | Optional exact source labels the external caller may send in request JSON.                          |
| `sources` / `source`                | no       | Alias for `allowedSources`.                                                                         |
| `export_names`, `export-names`, etc | no       | Snake_case and kebab-case aliases are accepted for the fields above.                                |

## Invocation URL format

External callers invoke package exports with the owner-scoped route:

`POST https://kody.codes/@:username/api/package-invocations/:kodyId/:exportName`

The `@:username` segment is required and must be the public username of the
package owner. Do not use the stale unscoped form
`/api/package-invocations/:kodyId/:exportName`.

Export names are normalized for token scope checks. The URL path usually omits
the leading `./`, so an export scoped as `./process-video` is invoked with the
path segment `process-video`.

Concrete YouTube WebSub Worker example:

```sh
curl -X POST \
	"https://kody.codes/@kentcdodds/api/package-invocations/youtube-livestream-vod-manager/process-video" \
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

When a token lists allowed sources, the request JSON `source` must match one of
those labels exactly. For Kent's YouTube Worker, use
`"source": "youtube-websub-proxy"`. When the list is empty, omit `source` or
send null; a named `source` is rejected.

Prefer canonical URL metadata from package discovery over manual string
construction. `package_get` and package entity search details include canonical
external invocation metadata with the URL, path, route export name, normalized
export name used for token scope checks, token setup URL, and source guidance
for each callable export.

A token belongs to one package. Cross-package HTTP clients call one package (an
orchestrator or discovery package) and use `packages.invoke` inside Kody, or
they speak MCP.

## Agent instructions

1. Identify the saved package and export the external system needs to call.
   - Use `package_get` so the setup URL includes the saved package id.
   - Use `*` only when the client should call every export on that package.
2. If debugging an existing setup, call `package_invocation_token_list` with
   that `package_id`, `package_invocation_token_get`, or read `tokens` from
   `package_get` first to confirm which token record exists and whether its
   export and allowed-source scopes match the external caller. Do not ask the
   user to read token metadata out of the browser UI unless the capability
   response is insufficient.
3. Generate an `/account/packages/<packageId>?newToken=1` URL with `name`,
   export scope, and optional `allowedSources`.
4. Ask the user to open the URL, paste their locally generated raw token into
   the Raw token field, or click **Generate** and copy/deliver the generated
   value before creating the token.
   - For rotation, ask the user to open the package details page, select the
     token, and paste or generate the new raw token.
   - The external service or secret store must receive the exact raw value that
     was pasted/generated.
5. Instruct the external caller to send:
   - `POST` to the canonical owner-scoped invocation URL from package metadata,
     not to an `/account/packages/...` setup URL
   - `Authorization: Bearer <raw-token>`
   - JSON `source` matching one of the allowed sources when the token lists
     sources; omit `source` when the list is empty
6. Never display, log, store in docs, or send raw token material through chat or
   query params.

## Verification notes for agents

The package details page is a browser-session UI route. Fetching
`/account/packages/:packageId` from MCP `execute` returns an HTML app shell, not
the client-loaded token list, and `/account/packages.json` requires the
signed-in browser session cookie. Agents should not treat missing token metadata
in the HTML shell as proof that a token was not saved.

For external invocation smoke tests, check failures in this order:

1. `owner_slug_required`: the endpoint is missing the `@:username` owner slug.
   Use `/@:username/api/package-invocations/:kodyId/:exportName`;
   `/api/package-invocations/...` is not an invocation route.
2. `not_found`: verify the owner slug matches the package owner and the kody id
   names a package that user owns.
3. `invalid_token` or `Invalid package invocation token`: the request reached
   bearer-token authentication on a correctly shaped owner-scoped endpoint.
   Rotate the package invocation token or check that the external secret
   contains the exact active raw bearer value scoped to that package.

Package export names and `source` policy are checked only after bearer-token
authentication succeeds.

## Related

- [External package invocation API](../contributing/package-invocation-api.md)
- [Packages](../use/packages.md)
