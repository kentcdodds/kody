---
id: connect_secret
title: Account secret setup guide
summary:
  Hosted /account/secrets/new URL shape, query params, approval policy for API
  keys and PATs, and post-hoc package approval URLs including bulk approve.
category: platform
---

# Account secret setup guide

Use the hosted **`/account/secrets/new`** page whenever the user needs to enter
a secret value such as an API key or personal access token. The agent must never
see the secret value.

If the secret will power a downstream package or package app, load
`coding_guide_get` with `guide: "integration_bootstrap"` before building that
package. For the common non-OAuth path after bootstrap, load `coding_guide_get`
with `guide: "secret_backed_integration"`. This guide covers the
secret-collection step only.

## When to use `/account/secrets/new`

Use it when:

- the user must provide a sensitive value
- a capability requires a secret placeholder that is missing
- the user needs to rotate a stored secret value

Do **not** ask the user to paste secrets into chat.

## URL format

Provide the user a URL like:

`https://<your-kody-origin>/account/secrets/new?name=exampleApiKey&description=Example%20API%20key&allowedHosts=api.example.com&scope=user&allowedCapabilities=example_capability&allowedPackages=pkg_123`

## Query params

| Param                 | Required | Description                                                                                                                |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`                | yes      | Secret name (for example `exampleApiKey`).                                                                                 |
| `description`         | no       | Human-readable description shown in the UI.                                                                                |
| `allowedHosts`        | no       | Comma-separated hosts to review for approval.                                                                              |
| `allowedCapabilities` | no       | Comma-separated capability names to review. Use only real Kody capability names from `search` or `meta_list_capabilities`. |
| `allowedPackages`     | no       | Comma-separated saved package ids to review for approval.                                                                  |
| `scope`               | no       | `user` (default) or `package`.                                                                                             |
| `packageId`           | no       | Required when `scope=package`. Use the saved package id that owns the secret.                                              |

## Approval policy reminders

- Saving a secret does **not** approve outbound hosts.
- The account form prefills the requested hosts/capabilities/packages for
  review.
- Host, capability, and package approvals are handled in the authenticated
  account secrets UI after the secret is saved.

## Package approval URLs (after a package exists)

Self-authored packages and adopted community forks (`community_fork_adopt`) can
read and use the user's secrets without an `allowed_packages` grant; updating or
deleting a user secret from package code still requires that grant. When an
**unadopted community-forked** package needs access to one or more **existing**
user secrets, either adopt it after reviewing the source or send the user an
approval link — do not ask them to recreate the secrets.

- Single secret:
  `/account/secrets/user/{secretName}?package_id={savedPackageId}&package={kodyId}`
- Multiple secrets for one package (preferred):
  `/account/secrets/approve?package_id={savedPackageId}&package={kodyId}&names={secret1},{secret2}`

Prefer the bulk `/account/secrets/approve?...&names=...` URL whenever two or
more secrets still need package approval. The account UI shows every listed
secret and lets the user approve them in one click.

## Agent instructions

1. Generate the URL with the required `name` and any optional params.
   - When using `scope=package`, include the saved package id in `packageId`.
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
