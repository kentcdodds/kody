# Account secret setup guide

Use the hosted **`/account/secrets/new`** page whenever the user needs to enter
a secret value such as an API key or personal access token. The agent must never
see the secret value.

If the secret will power a downstream package or package app, load
`kody_official_guide` with `guide: "integration_bootstrap"` before building that
package. For the common non-OAuth path after bootstrap, load
`kody_official_guide` with `guide: "secret_backed_integration"`. This guide
covers the secret-collection step only.

## When to use `/account/secrets/new`

Use it when:

- the user must provide a sensitive value
- a capability requires a secret placeholder that is missing
- the user needs to rotate a stored secret value

Do **not** ask the user to paste secrets into chat.

## URL format

Provide the user a URL like:

`https://heykody.dev/account/secrets/new?name=linearApiKey&description=Linear%20API%20key&allowedHosts=api.linear.app&scope=user&allowedCapabilities=linear_issue_list,linear_issue_create&allowedPackages=pkg_123`

## Query params

| Param                 | Required | Description                                                                                                                |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`                | yes      | Secret name (for example `linearApiKey`).                                                                                  |
| `description`         | no       | Human-readable description shown in the UI.                                                                                |
| `allowedHosts`        | no       | Comma-separated hosts to review for approval.                                                                              |
| `allowedCapabilities` | no       | Comma-separated capability names to review. Use only real Kody capability names from `search` or `meta_list_capabilities`. |
| `allowedPackages`     | no       | Comma-separated saved package ids to review for approval.                                                                  |
| `scope`               | no       | `user` (default) or `app`.                                                                                                 |
| `appId`               | no       | Required when `scope=app`. Use the saved package id that owns the package app secret scope.                                |

## Approval policy reminders

- Saving a secret does **not** approve outbound hosts.
- The account form prefills the requested hosts/capabilities/packages for
  review.
- Host, capability, and package approvals are handled in the authenticated
  account secrets UI after the secret is saved.

## Agent instructions

1. Generate the URL with the required `name` and any optional params.
   - When using `scope=app`, include the saved package id in `appId`.
   - Only include `allowedCapabilities` when you have confirmed the capability
     names exist in Kody.
2. Ask the user to open the URL in their browser.
3. Wait until they confirm the secret is saved.
4. If the secret will back a package or package app, run the authenticated smoke
   test described in `guide: "integration_bootstrap"` before saving the
   downstream package.
5. For common non-OAuth integrations, continue with
   `guide: "secret_backed_integration"` after the secret exists.
6. Proceed using `{{secret:name}}` placeholders or the relevant capability.
