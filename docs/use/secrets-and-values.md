# Secrets, values, and host approval

## Secrets

Secret **values** do not belong in chat. Prefer **saved secrets**, **generated
UI** flows, or execution-time persistence when a token already exists inside
trusted code.

Use **search** first to discover saved secret references or connectors before
switching to **execute**.

During **execute**, **`await codemode.secret_list({})`** (or a narrowed
**`scope`** such as **`app`**) returns **metadata only**: names, descriptions,
allowed hosts, allowed capabilities — not plaintext values.

**`codemode.secret_set(...)`** persists a value that is already available inside
execution (for example a refreshed OAuth token). It does not return secret
values.

## Placeholders in `fetch` and capability inputs

Outbound **`fetch`** can include placeholders such as **`{{secret:tokenName}}`**
or **`{{secret:tokenName|scope=user}}`** in the URL, headers, or body. The host
resolves them for **approved** destinations.

Some capability fields opt in with **`x-kody-secret: true`**; those accept the
same placeholder form instead of raw credentials.

Placeholders are **not** general-purpose string interpolation. They only work in
secret-aware **`fetch`** paths and in capability inputs that explicitly allow
them.

## Signing JWTs with saved private keys

Use **`codemode.jwt_sign(...)`** when a workflow needs a JWT signed by a private
key stored in a saved secret. The primitive returns **`{ jwt, algorithm }`**:
use **`result.jwt`** as the compact JWT and **`result.algorithm`** for the
signing algorithm. It never returns private key material. The saved secret must
approve the **`jwt_sign`** capability before it can be used.

The caller supplies the JWT header and claims, then performs any provider-
specific token exchange with ordinary **`fetch`**. For service-account JSON
secrets, pass **`privateKeyJsonField: "private_key"`** to sign with that field.

Do **not** place literal placeholder tokens into user-visible or
third-party-visible content such as issue bodies, comments, prompts, logs, or
returned strings. If you need to describe a placeholder as text, obfuscate it
instead of embedding the exact **`{{secret:...}}`** form into content that may
later be sent over **`fetch`**.

## Host approval

If a request fails because a host is not approved for that secret, use the
approval path the error provides (typically in the web app). Saving a secret
does not by itself approve new hosts.

## Values

Use **values** capabilities for readable non-secret configuration that generated
UI or workflows should store and read later.
