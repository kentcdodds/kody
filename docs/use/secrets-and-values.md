# Secrets, values, and host approval

## Secrets

Credential setup uses **saved secrets**, **`/connect/oauth`** for OAuth,
**`/account/secrets/new`** for API keys and PATs, or execution-time persistence
when a token already exists inside trusted code.

Use **search** first to discover saved secret references or integrations before
switching to **execute**.

During **execute**, **`await kody.secret_list({})`** (or a narrowed **`scope`**
such as **`package`**) returns **metadata only**: names, descriptions, allowed
hosts, allowed capabilities — not plaintext values.

Package-scoped secrets belong to one saved package and are available only while
that package runs. Access rules for user-scoped secrets from package code are
covered in [Package approval](#package-approval).

**`kody.secret_set(...)`** persists a value that is already available inside
execution (for example a refreshed OAuth token). It does not return secret
values.

## Built-in integrations

Some providers are available as **built-in integrations**: the deployment
operator has already registered the OAuth app, so you connect with one click at
**`/connect/oauth?provider=<slug>`** — no provider developer console, client ID,
or client secret needed. Agents can list the available built-in apps with
**`integration_platform_app_list`**. Tokens for a built-in connection are stored
as your own secrets, the same as any other integration.

Built-in or not, a connection authorizes _your_ agent — and any code you run or
install — to act as you on that provider. Kody does not control or supervise
what your agent does with the access you grant; scope connections deliberately
and revoke unused ones. See the [Terms](/terms).

## Placeholders in `fetch` and capability inputs

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

Some capability fields opt in with **`x-kody-secret: true`**; those accept the
same placeholder form instead of raw credentials.

Placeholders are **not** general-purpose string interpolation. They only work in
secret-aware **`fetch`** paths and in capability inputs that explicitly allow
them.

## Signing JWTs with saved private keys

Use **`kody.secret_jwt_sign(...)`** when a workflow needs a JWT signed by a
private key stored in a saved secret. The primitive returns
**`{ jwt, algorithm }`**: use **`result.jwt`** as the compact JWT and
**`result.algorithm`** for the signing algorithm. It never returns private key
material. The saved secret must approve the **`secret_jwt_sign`** capability
before it can be used.

The caller supplies the JWT header and claims, then performs any provider-
specific token exchange with ordinary **`fetch`**. For service-account JSON
secrets, pass **`private_key_json_field: "private_key"`** to sign with that
field.

## Mentioning placeholders without resolving them

Resolution runs on the **final serialized request** (URL, headers, body), so a
literal placeholder assembled by any means — including string concatenation —
will resolve. Do **not** place resolvable placeholder tokens into user-visible
or third-party-visible content such as issue bodies, comments, prompts, logs, or
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
approval path the error provides (typically in the web app). Saving a secret
does not by itself approve new hosts.

## Package approval

User-scoped secrets are available automatically for **reading and using**
(mounts, fetch placeholders, capability inputs) to packages the user authored
themselves, and to adopted community forks (`community_fork_adopt` after a real
source review). Unadopted community-forked packages need explicit **package**
approval (`allowed_packages`) before those read/use paths. Updating or deleting
a user secret from package code (`secret_set`, `secret_delete`, OpenAPI
token-refresh writes) always needs the grant, including for self-authored and
adopted packages. Saving a secret, approving a host, or succeeding in an ad hoc
execute smoke test does not grant package access. Host and capability approvals
are unchanged.

When several secrets need the same package approved, Kody can provide a bulk
approval URL shaped like
`/account/secrets/approve?package_id=...&names=secretA,secretB`. That page lists
every pending secret and approves them in one click. Single-secret links still
work for one-off grants. For community forks, reviewing the source and calling
`community_fork_adopt` is an alternative to sending those approval links.

## Package config vs package storage

Package-scoped secrets and app-scoped values are **package config**: they are
keyed by the saved package id (secret buckets for the package; value buckets use
`appId` set to that package id). They hold credentials and readable settings,
not application records.

Durable package data — rows, documents, checkpoints — lives in the package
storage bucket via `packageStorage()`. See
[Package state model](./packages.md#package-state-model).

## Values

Use **values** capabilities for readable non-secret configuration that generated
UI or workflows should store and read later.
