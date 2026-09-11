# Secrets and host approval

## Secrets

Credential setup uses **saved secrets**, **`/connect/oauth`** for OAuth,
**`/account/secrets/new`** for API keys and PATs, or execution-time persistence
when a token already exists inside trusted code.

Use **search** first to discover saved secret references or integrations before
switching to **execute**.

During **execute**, **`await kody.secretList({})`** (or a narrowed **`scope`**
such as **`package`**) returns **metadata only**: names, descriptions, allowed
hosts, **`package_id`** for package-scoped secrets, **`expires_at`**, and
remaining **`ttl_ms`** — not plaintext values. Explicit listing includes
caller-owned package-scoped metadata even without a package runtime; using a
package secret still requires package context. **search** does not return or
rank package-scoped secret references. Expired secrets stay in the list with
**`ttl_ms: 0`**. Fetch placeholders and **`resolve`** treat them as missing so
Kody stops sending the value.

Package-scoped secrets belong to one saved package. **`packageGet`** includes
their metadata as an FYI when you are inspecting that package. User-scoped
secrets follow the bundler stamp: code that originates from package A authorizes
as A, including when B statically imports A's export. B's own code still cannot
read a secret locked only to A — including by passing A's id to
`kody.packageSecretGet` / `Has`. Only A's stamped `packageSecrets` binding
carries that authority. Access rules are covered in
[Package approval](#package-approval).

**`kody.secretSet(...)`** persists a value that is already available inside
execution (for example an API key the package just minted). It does not return
secret values. Do not use it for OAuth access or refresh tokens —
`/connect/oauth` and **`createAuthenticatedFetch`** /
**`integrationTokenRefresh`** persist those on the connection. Optional
**`expires_at`** is a UTC ISO timestamp (or `YYYY-MM-DD` at midnight UTC). Omit
it to leave an existing expiry unchanged; pass `null` to clear. Updates that
only change description or expiry may omit **`value`**. Package runtimes cannot
change expiry on a user secret.

The account create/edit form has the same optional expiry field. Agents
prefilling **`/account/secrets/new`** can set **`expiresAt`** as a query
parameter so the human pastes the token without typing the date. See
[Account secret setup](../guides/account-secret-setup.md).

A connection authorizes _your_ agent — and any code you run or install — to act
as you on that provider. Kody does not control or supervise what your agent does
with the access you grant; scope connections deliberately and revoke unused
ones. See the [Terms](/terms).

## Placeholders in `fetch`

Outbound **`fetch`** can include placeholders such as **`{{secret:tokenName}}`**
or **`{{secret:tokenName|scope=user}}`** in the URL, headers, or body. The host
resolves them for **approved** destinations.

When an API requires Basic Auth derived from two saved secrets, import
**`secretHeaders`** from **`kody:runtime`** and put the opaque helper result in
the outbound fetch header. This example uses a placeholder API host and generic
client credential secret names:

```ts
import { secretHeaders } from 'kody:runtime'

await fetch('https://api.example.com/oauth/token', {
	method: 'POST',
	headers: {
		Authorization: secretHeaders.basic({
			usernameSecret: 'exampleClientId',
			passwordSecret: 'exampleClientSecret',
			scope: 'user',
		}),
		'Content-Type': 'application/x-www-form-urlencoded',
	},
	body: new URLSearchParams({ grant_type: 'client_credentials' }),
})
```

Kody resolves both secrets and sends only the derived `Basic ...` header to the
approved host. The target host must be approved separately for both saved
secrets.

Placeholders are **not** general-purpose string interpolation. They only work in
secret-aware **`fetch`** paths.

## Signing JWTs with saved secrets

Use **`kody.secretJwtSign(...)`** when a workflow needs a JWT signed by a key
stored in a saved secret. The primitive returns **`{ jwt, algorithm }`**: use
**`result.jwt`** as the compact JWT and **`result.algorithm`** for the signing
algorithm. It never returns key material.

The caller supplies the JWT header and claims, then performs any provider-
specific token exchange with ordinary **`fetch`**. Pass the saved secret as
**`private_key_secret_name`** (the signing-key secret: PKCS#8 PEM for asymmetric
algorithms, HMAC key material for HS*). For service-account JSON secrets, pass
**`private_key_json_field: "private_key"`** to sign with that field. Supported
algorithms:

- **HMAC:** `HS256`, `HS384`, `HS512` — **`key_encoding`** is **`base64`**
  (default, DoorDash Drive `signing_secret`), **`utf8`**, or **`base64url`**
- **RSA PKCS#1:** `RS256` (default), `RS384`, `RS512`
- **RSA-PSS:** `PS256`, `PS384`, `PS512`
- **ECDSA:** `ES256`, `ES384`, `ES512`
- **EdDSA:** Ed25519 PKCS#8 keys (Cursor Origin app JWTs)

## Mentioning placeholders without resolving them

Resolution runs on the **final serialized request** (URL, headers, and
non-multipart body), so a literal placeholder assembled by any means — including
string concatenation — will resolve. `multipart/*` bodies are opaque:
placeholders inside a part are not resolved (put credentials in the URL or
headers). Do **not** place resolvable placeholder tokens into user-visible or
third-party-visible content such as issue bodies, comments, prompts, logs, or
returned strings.

- To **mention** the syntax in prose or docs, write **`{{secret:<name>}}`**.
  Angle brackets are outside the placeholder name charset (`[a-zA-Z0-9._-]`), so
  this form is inert everywhere — it cannot resolve in this request or any later
  one.
- To deliberately send a **resolvable** literal placeholder to a third party
  (for example, config text that Kody itself will resolve later), set the
  **`x-kody-secret-resolution: off`** header on that **`fetch`**. The gateway
  strips the header and skips all placeholder resolution for that one request.
  Only the calling code can set headers, so data flowing through a URL or body
  can never disable resolution. Use this sparingly: the delivered text is still
  one resolution step away from the real secret if it later flows back through a
  secret-aware **`fetch`**.

## Host approval

If a request fails because a host is not approved for that secret, use the
approval path the error provides. Host approval lives on the dedicated
**`/connect/secrets`** page — the same kind of focused page as
**`/connect/oauth`**. A link looks like
`/connect/secrets?name=cloudflareToken&hosts=api.cloudflare.com`. When several
hosts (or several secrets) need approval together, Kody can send one link with
comma-separated **`names`** and **`hosts`**. That page lists every valid host
and approves them in one click. Values that are not hostname-shaped (a truncated
token such as `api.ope`, a path such as `api.openai.com/v1`, empty or
whitespace) are shown as invalid and are not written to the allowlist — copy the
link again if a client wrapped it.

Saving a secret does not by itself approve new hosts. Self-authored and adopted
packages do not skip this gate: an empty host allowlist blocks secret-bearing
fetch even when package read/use is automatic.

## Package approval

User-scoped secrets are available automatically for **reading and using**
(mounts, fetch placeholders, named capability lookups including `secretList`) to
packages the user authored themselves and adopted community forks
(`communityForkAdopt` after a real source review). Unadopted community-forked
packages need explicit **package** approval (`allowed_packages`) before those
read/use paths. Approval is checked against the **stamped** package — the module
that originated the call — not the importing run. Dependents statically import
the owning export; they do not need their own grant for secrets locked to that
owner. Updating or deleting a user secret from package code (`secretSet`,
`secretDelete`) always needs the grant on the stamp package, including for
self-authored and adopted packages. Only the account owner can add a package to
that grant on `/account/secrets/user/:name` or `/account/secrets/approve`.
**`secretLock`** returns an approval URL for the owner to click (one-click
Allow, same spirit as `/connect/secrets`); it does not change
`allowed_packages`. Send the link and wait. Removing a grant is also
website-only. `secretSet` cannot change `allowed_packages`. Official OAuth token
rotation (`createAuthenticatedFetch` 401 retry via `integrationTokenRefresh`)
persists host-side and does not need that write grant.

**Host approval is separate and is never automatic**, including for
self-authored and adopted packages. An empty host allowlist blocks
`{{secret:name}}` fetch placeholders even when package read/use is automatic.
Saving a secret or succeeding in an ad hoc execute smoke test does not approve a
host or grant package write access.

When several secrets need the same package approved, Kody can provide a bulk
approval URL shaped like
`/account/secrets/approve?package_id=...&names=secretA,secretB`. That page lists
every pending secret and approves them in one click. A single-secret link grants
one package on one secret. For community forks, reviewing the source and calling
`communityForkAdopt` is an alternative to sending those approval links.

## Package config vs package storage

Package-scoped secrets are **package config**: they are keyed by the saved
package id. They hold credentials, not application records.

Durable package data — rows, documents, checkpoints — lives in the package
storage bucket via `packageStorage()`. See
[Package state model](./packages.md#package-state-model).

## Named state

Durable facts and preferences belong in memories. Package runtime state and
knobs belong in `packageStorage()`. Versioned config belongs in a repo.
Credentials belong in secrets. OAuth client ids belong in integrations. OAuth
access and refresh tokens, and a user-registered app's client secret, live on
the integration — they do not appear in the Secrets list. PATs, API keys, and
webhook HMAC secrets stay in the secret store.
