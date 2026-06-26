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

When the exact bearer value does not matter, the user can click **Generate** in
the raw-token field. Kody generates a high-entropy browser-side token, fills the
password field, and offers a **Copy** control so the user can paste it into the
external service or secret store. After saving, Kody stores only the hash and
will not show the raw value again.

## URL format

Provide the user a URL like:

`https://heykody.dev/account/package-invocation-tokens/new?name=Discord%20Gateway&packageKodyIds=discord-gateway&exportNames=dispatch-message-created&allowedSources=discord-gateway`

Wildcard package/export setup for a highly trusted personal client:

`https://heykody.dev/account/package-invocation-tokens/new?name=Personal%20automation&packageKodyIds=*&exportNames=*&allowedSources=personal-client`

## Query params

Repeat params or comma-separate values for list fields. The form also accepts
common snake_case and kebab-case aliases so agents can construct URLs from API
field names without extra translation.

| Param                                       | Required | Description                                                                                                             |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `name`                                      | yes      | Human-readable token name.                                                                                              |
| `packageKodyIds` / `packageKodyId`          | yes\*    | Saved package `kody.id` values, or `*` for all packages owned by the signed-in Kody user.                               |
| `kodyIds` / `kodyId`                        | yes\*    | Alias for `packageKodyIds`.                                                                                             |
| `packageIds` / `packageId`                  | yes\*    | Saved package ids, or `*` for all packages owned by the signed-in Kody user.                                            |
| `exportNames` / `exportName`                | yes      | Package export names. `dispatch-message-created` is normalized to `./dispatch-message-created`; `*` allows all exports. |
| `allowedSources` / `allowedSource`          | no       | Optional exact source labels the external caller may send in request JSON.                                              |
| `sources` / `source`                        | no       | Alias for `allowedSources`.                                                                                             |
| `package_kody_ids`, `package-kody-ids`, etc | no       | Snake_case and kebab-case aliases are accepted for the fields above.                                                    |

\* At least one package scope is required: either a package Kody id scope or a
package id scope.

## Agent instructions

1. Identify the saved package and export the external system needs to call.
   - Use package Kody ids when possible because they are human-readable.
   - Use `*` only for highly trusted personal clients.
2. Generate a `/account/package-invocation-tokens/new` URL with `name`, package
   scope, export scope, and optional `allowedSources`.
3. Ask the user to open the URL, paste their locally generated raw token into
   the Raw token field, or click **Generate** and copy/deliver the generated
   value before creating the token.
   - For rotation, ask the user to open the existing token detail URL and paste
     the new raw token into the write-only replacement field.
4. Instruct the external caller to send:
   - `Authorization: Bearer <raw-token>`
   - JSON `source` matching one of the allowed sources when sources are scoped
5. Never display, log, store in docs, or send raw token material through chat or
   query params.

## Related

- [External package invocation API](../contributing/package-invocation-api.md)
- [Packages](../use/packages.md)
