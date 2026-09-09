---
id: secrets
title: Secrets
summary:
  How Kody lets your agent use your API keys, tokens, and private keys without
  ever reading them: the no-secret_get rule, `{{secret:name}}` placeholders
  resolved at the network boundary, host approval, package approval and locks,
  expiry, and where each kind of credential lives. Load this when someone asks
  how credentials work or whether the agent can see a key.
category: platform
---

# Secrets

A secret is a credential stored on your Kody account — an API key, a personal
access token, a webhook signing secret, a private key. Your agent can write code
that uses a secret. It can never read one.

## The rule: there is no `secret_get`

The secrets capabilities are `secretList`, `secretSet`, `secretSetMany`,
`secretLock`, `secretDelete`, and `secretJwtSign`. Nothing returns a value.
`secretList` returns metadata only: names, descriptions, approved hosts, expiry,
and remaining time to live.

This is why you can hand an agent a job that needs your GitHub token without the
token ever entering the prompt, the transcript, or the model provider's logs.
The same is true for every agent connected to the account: the secret is shared;
the value is shared with none of them.

## How code uses a secret

Code refers to a secret by name. Kody substitutes the value at the network
boundary, on the final serialized request, and only for hosts you approved.

- **Placeholders in `fetch`** — `{{secret:githubAccessToken}}` in a URL, header,
  or body of an outbound `fetch` resolves when the request leaves Kody. This is
  not general string interpolation; it works only in secret-aware `fetch`.
- **Derived headers** — when an API wants Basic Auth built from two secrets,
  `secretHeaders.basic({ usernameSecret, passwordSecret })` from `kody:runtime`
  produces the header without exposing either half.
- **Signed JWTs** — `secretJwtSign` signs a JWT with a stored private key (RS256
  or EdDSA) and returns the compact token, never the key.

Placeholders are live tokens. Do not paste one into an issue body, a comment, a
log line, or a returned string — write `{{secret:<name>}}` with angle brackets
when you need to mention the syntax in prose.

## Two approvals, both yours

Saving a secret does not by itself let anything use it.

- **Host approval** decides which destinations a secret may be sent to. A secret
  with an empty host allowlist blocks every placeholder fetch, including from
  packages you wrote yourself. Approve hosts on `/connect/secrets` — one link
  can cover several secrets and several hosts at once. Kody never approves a
  host automatically; an ad hoc smoke test that happened to work does not widen
  the allowlist.
- **Package approval** decides which saved packages may read and use a
  user-scoped secret. Packages you authored and community forks you adopted
  after reviewing the source get read/use automatically. Unadopted forks need an
  explicit grant. Updating or deleting a user secret from package code always
  needs the grant. Agents add a package with `secretLock`; removing a grant is
  website-only on `/account/secrets/user/:name`.

Bulk approval URLs (`/account/secrets/approve?package_id=…&names=a,b`) let you
approve several pending secrets for one package in a click.

## Scopes

- **User secrets** belong to the account and can be approved for any package.
- **Package secrets** belong to one saved package and exist only while that
  package runs — they are package config, keyed by the package id.

OAuth access and refresh tokens are different: they live on the integration,
rotate through `createAuthenticatedFetch`, and do not appear in the secrets
list. A pasted API key is a secret; a Slack login is an integration. See
[Packages, integrations, and MCP servers](./packages-integrations-mcp.md).

## Expiry

A secret can carry an expiry (`expires_at`). Expired secrets stay listed with
`ttl_ms: 0`, and placeholders treat them as missing so Kody stops sending the
value. Agents prefilling `/account/secrets/new` can set `expiresAt` in the query
string so the person pastes the token without typing a date.

## When a token is coarser than the job

Providers do not always offer the scope you want. Gmail has a send scope and no
drafts-only scope. When the token can do more than the job should, publish the
narrow behavior as a package, lock the package, and lock the integration to it.
After that, `execute` cannot borrow the token and a later publish cannot quietly
add a send path. See [Gmail drafts without send](./locked-gmail-drafts.md) and
[Lock an MCP server to a package](./locked-mcp-server.md) for the same pattern
on connected tool servers.

## Adding a secret

- Pasting a key or PAT: the agent sends you a prefilled `/account/secrets/new`
  link; you paste the value into the page, never into chat. URL shape and
  parameters: [Secret setup URL reference](./account-secret-setup.md).
- Building an integration around one or more secrets:
  [Secret-backed integrations](./secret-backed-integration.md).
- A token that already exists inside trusted code (a key the package just
  minted): `secretSet` persists it without returning it.

## Where to go next

- [Secrets and host approval](../use/secrets-and-values.md) — the MCP-level
  reference with the exact placeholder, header, and approval semantics.
- [Integration bootstrap](./integration-bootstrap.md) — the sequence before a
  secret-backed package is saved.
