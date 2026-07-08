# Secrets, values, and host approval

## Secrets

Credential setup uses **saved secrets**, **`/connect/oauth`** for OAuth,
**`/account/secrets/new`** for API keys and PATs, or execution-time persistence
when a token already exists inside trusted code.

Use **search** first to discover saved secret references or integrations before
switching to **execute**.

During **execute**, **`await kody.secret_list({})`** (or a narrowed **`scope`**
such as **`app`**) returns **metadata only**: names, descriptions, allowed
hosts, allowed capabilities — not plaintext values.

**`kody.secret_set(...)`** persists a value that is already available inside
execution (for example a refreshed OAuth token). It does not return secret
values.

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

## Values

Use **values** capabilities for readable non-secret configuration that generated
UI or workflows should store and read later.
