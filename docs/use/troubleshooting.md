# Troubleshooting

## Contact support

For help with the hosted Kody service at `heykody.dev`, email
[`support@heykody.dev`](mailto:support@heykody.dev). Operators of other Kody
deployments receive support mail at `support@<apex>`, where `<apex>` is the
deployment's `APP_BASE_URL` hostname.

## MCP requests fail with `email_verification_required`

Kody requires a verified account email before any MCP access, including OAuth
authorization. Open the verification link sent at signup, or sign in and use
**Resend verification email** on `/pending-verification`, `/account`, or the
authorize page. Keep an open `/oauth/authorize` tab so you can continue the same
OAuth request after verifying in another tab, then reconnect or approve again.

## Search returns no good matches

- **Rephrase the query** using domain vocabulary from the search tool’s domain
  hints (for example “GitHub”, “Cloudflare”, “meta capabilities”).
- Try **`meta_list_capabilities`** for the full live registry, including dynamic
  entries from remote connectors.
- **`entity: "id:capability"`** looks up a **known** id. It does **not** turn an
  empty ranked **`query`** into better matches — rephrase or list capabilities
  instead.

## Saved packages missing

Saved packages require an **authenticated MCP user**. If the client is not
signed in, user-scoped package results are empty.

## Fetch or secret errors

- **Host not approved:** complete the approval flow in the app for that secret
  and host.
- **Capability not allowed for secret:** adjust the secret’s allowed-capability
  policy or use a capability that is on the allowlist.

## Remote connectors

If connector-provided tools appear missing, check connector status with
**`meta_list_remote_connector_status`**. For protocol and URL requirements, see
[Remote connectors](../contributing/architecture/remote-connectors.md).

## Job, webhook, or package app failed

Open **[`/account/activity`](./activity.md)** (failures-first) or ask your agent
to use **`run_summary`** / **`run_list`** / **`run_get`**. Successful key-less
ad-hoc **`execute`** calls are not stored there — only execute failures, keyed
execute runs (including successes), and other runtime surfaces.
