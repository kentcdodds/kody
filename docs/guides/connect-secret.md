# Connect secret guide

Use the hosted **`/connect/secret`** page whenever the user needs to enter a
secret value such as an API key or personal access token. The agent must never
see the secret value.

If the secret will power a downstream package or package app, load
`kody_official_guide` with `guide: "integration_bootstrap"` before building
that package. For the common non-OAuth path after bootstrap, load
`kody_official_guide` with `guide: "secret_backed_integration"`. This guide
covers the secret-collection step only.

## When to use `/connect/secret`

Use it when:

- the user must provide a sensitive value
- a capability requires a secret placeholder that is missing
- the user needs to rotate a stored secret value

Do **not** ask the user to paste secrets into chat.

## URL format

Provide the user a URL like:

`https://heykody.dev/connect/secret?name=linearApiKey&description=Linear%20API%20key&allowedHosts=api.linear.app&scope=user&dashboardUrl=https://linear.app/settings/api&instructions=Go%20to%20Linear%20Settings%20%E2%86%92%20API%20%E2%86%92%20Personal%20API%20Keys%20%E2%86%92%20Create%20key&allowedCapabilities=linear_issue_list,linear_issue_create&connector=linear`

## Query params

| Param                 | Required | Description                                                                                                                |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`                | yes      | Secret name (for example `linearApiKey`).                                                                                  |
| `description`         | no       | Human-readable description shown in the UI.                                                                                |
| `allowedHosts`        | no       | Comma-separated hosts to review for approval.                                                                              |
| `allowedCapabilities` | no       | Comma-separated capability names to review. Use only real Kody capability names from `search` or `meta_list_capabilities`. |
| `scope`               | no       | `user` (default), `session`, or `app`.                                                                                     |
| `appId`               | no       | Required when `scope=app`. Use the saved package id that owns the package app or package-owned secret scope.               |
| `dashboardUrl`        | no       | Provider settings link for creating the key.                                                                               |
| `instructions`        | no       | Step-by-step instructions shown on the page.                                                                               |
| `connector`           | no       | Writes `_connector-secret:{connector}` secret-binding metadata on save.                                                    |

## Approval policy reminders

- Saving a secret does **not** approve outbound hosts.
- The connect page only shows the requested hosts/capabilities for review.
- Host and capability approvals are handled in the authenticated account secrets
  UI after the secret is saved.

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
