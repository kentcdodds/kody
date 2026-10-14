---
id: credentials
title: Credentials
summary:
  What a Kody credential is and every kind it comes in (Key, OAuth, MCP server,
  URL, login, signing), how `{{secret:name}}` placeholders and scoped
  `credential(key)` clients place a value at the network boundary, how packages
  declare needs in `kody.credentials`, how callers pick between credentials with
  names and call maps, the `credential_ambiguous` / `credential_unbound` errors,
  and webhook verification. Load this when someone asks how credentials work,
  which kind to use, or why a credential did not resolve.
category: platform
---

# Credentials

A credential is anything Kody uses to reach a service for you: an API key, an
OAuth connection, an MCP server, a webhook URL, a username and password, or a
signing key. Credentials belong to an org (or to you, as personal credentials)
and show up together on your org's **Credentials** page.

One rule holds for every kind: **a credential's value never enters package code
or your code.** Code names a credential. Kody puts the value into the outgoing
request at the network boundary, only for the hosts that credential allows, and
only over HTTPS. Agents, packages, logs, and tool output never see it.

## The kinds

| Kind       | What it holds                                                | How code uses it                                           |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Key        | An API key, personal access token, or webhook signing secret | `{{secret:name}}` placeholders, or `credential(key).fetch` |
| OAuth      | A connection you signed in to (GitHub, Google, Slack, …)     | `credential(key).fetch`, or `{{integration-token:name}}`   |
| MCP server | A remote MCP server connection                               | `credential(key).callTool`                                 |
| URL        | A whole secret URL (a chat webhook, a `/bot<token>` base)    | `credential(key).fetch` with a relative path               |
| Login      | Login fields Kody exchanges for a session token              | `credential(key).fetch`                                    |
| Signing    | A signing secret or private key                              | `credential(key).sign`                                     |

Secrets (the Key kind) and integrations (the OAuth kind) are both credentials.
The kind names in manifests and APIs are `secret`, `oauth`, `mcp`, `url`,
`login`, and `signing`.

Custom secret providers (vaults such as 1Password) are not a credential kind.
Granting Kody access to a vault is a separate trust decision, so they have their
own page; see [Custom secret providers](./secret-providers.md).

Every credential has:

- **name**: yours to choose, such as `work` or `personal`. Callers pick a
  credential by name.
- **scope**: `org` (shared with the org under its Use grants) or `personal`
  (yours, granted to an org one org at a time).
- **provider**: an optional slug such as `github`. Package needs match on it.
- **hosts**: the only hosts the value may be sent to, over HTTPS. Hosts live on
  the credential, never in a package manifest, so publishing or forking a
  package cannot widen them.
- **inject** (Keys used through `credential()`): where the value goes, a header,
  Basic auth, or a query parameter. The default is
  `Authorization: Bearer {value}`.

## Keys and placeholders

A Key is a saved secret. Write `{{secret:name}}` anywhere in a `fetch` request:
a header, the URL path or query, or a text body. When the request leaves Kody,
the gateway checks it and fills in the value.

> [!DIAGRAM] placeholder-fill Your code sends `{{secret:github}}`. The Kody
> gateway checks that the request is HTTPS and goes to a host the credential
> allows, swaps in the value, and redacts the value if the response echoes it
> back.

```ts
const response = await fetch('https://api.github.com/user/repos', {
	headers: { Authorization: 'Bearer {{secret:github}}' },
})
```

- The request must be HTTPS and its host must be one you approved for that
  secret. Otherwise it is refused with an error naming the secret and host; a
  placeholder is never sent unfilled.
- You approve a Key's hosts on the approval link your agent sends
  (`/connect/secrets`). A Key with no approved hosts sends nowhere.
- If the remote service echoes the value back, the gateway replaces it with
  `[REDACTED SECRET]` before your code reads the response.
- `{{integration-token:name}}` works the same way for an OAuth connection, on
  the integration's own hosts.

Keys and placeholders work this way permanently. Every other approach on this
page is an optional, more secure path you can adopt when it fits, with no forced
migration. Full placeholder rules (encodings, multipart, the
`x-kody-secret-resolution` header):
[Secrets and host approval](../use/secrets-and-values.md#placeholders-in-fetch).

## Scoped clients: `credential(key)`

With a placeholder, the code decides where the value goes. With a scoped client,
the **credential** decides: its hosts and inject rule say where the value is
placed, and it is never placed in a request body. Code gets a client that holds
an opaque handle, not a value.

```ts
import { credential } from 'kody:runtime'

const github = await credential('github')
const response = await github.fetch('https://api.github.com/user/repos')
```

The client has `name`, `scope`, `kind`, and `hosts`, plus one of:

- `fetch` for Key, OAuth, URL, and login credentials,
- `callTool` for MCP servers,
- `sign` for signing credentials.

A relative URL resolves against the credential's first exact host. An absolute
URL must be on one of its hosts. If code sets the header the credential injects,
the credential's value replaces it. Redirects are followed by the client, and
the credential only travels to its own hosts. A 401 or 403 response carries an
`x-kody-credential-hint` header naming the inject shape (for example
`header Authorization Bearer`), never the value.

`credentials(key)` returns an array of clients for a need declared with
`multiple: true`.

### Declare needs in `kody.credentials`

A package lists the credentials it needs in `package.json`. Each need has a
provider (which defaults to the key) and a required description that tells the
person choosing a credential why the package wants it.

```json
{
	"name": "@you/pr-digest",
	"exports": { "./summarize": "./src/summarize.ts" },
	"kody": {
		"description": "Summarize open pull requests every morning.",
		"credentials": {
			"github": { "description": "Read pull requests to summarize them" },
			"slack": { "description": "Post the summary to a channel" }
		}
	}
}
```

`kind` is optional. Without it, any credential for that provider that can make
requests matches: a Key such as a personal access token, an OAuth connection, or
a login. `credential('github')` picks the right path for whichever one is used
(placing the Key's header, refreshing an OAuth token once on a 401, or running
the login exchange), so the package code is identical for a PAT and for OAuth.

Declare `kind` only when the package needs a specific shape:

```json
"credentials": {
	"github": { "description": "Read pull requests to summarize them" },
	"apple-music": { "kind": "signing", "description": "Sign developer tokens" },
	"linear": { "kind": "mcp", "description": "Create issues for failing checks" },
	"alerts-bot": { "kind": "url", "provider": "telegram", "description": "Post alerts" },
	"google": { "kind": "oauth", "multiple": true, "description": "Calendars to include" }
}
```

- `signing` for `sign()`, `mcp` for `callTool()`, `url` for a whole-URL secret,
  or `oauth` when the provider only works through OAuth (Google user data, for
  example).
- A second account from the same provider gets its own key with an explicit
  `provider`.
- Needs have no hosts or placement fields. Those belong to the credential.

## Each kind through `credential()`

### Key

Any saved Key can be used through a client. Set its provider so needs match it,
and its inject if the service does not take `Authorization: Bearer`
(`credentialList` returns each credential's `id`):

```ts
import { kody } from 'kody:runtime'

await kody.credentialUpdate({
	credential_id: 'cred_…',
	provider: 'anthropic',
	inject: { kind: 'header', name: 'x-api-key', format: '{value}' },
})
```

```ts
import { credential } from 'kody:runtime'

const anthropic = await credential('anthropic')
const response = await anthropic.fetch(
	'https://api.anthropic.com/v1/messages',
	{
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({ model, max_tokens: 512, messages }),
	},
)
```

The inject options are `{ kind: 'header', name, format }` (the format holds
`{value}` once), `{ kind: 'basic', valueAs: 'password', other: 'api' }` (the
value is the password and `other` is a literal username, or the reverse), and
`{ kind: 'query', param }`. The same Key keeps filling `{{secret:name}}`
placeholders; inject and provider only affect clients.

### OAuth

Connect the service once (your agent sends a `/connect/oauth` link). Kody keeps
the token fresh. Code looks exactly like the Key example:

```ts
const github = await credential('github')
const response = await github.fetch('https://api.github.com/user')
```

On a 401 the client refreshes the token and retries once. OAuth connections
always use `Authorization: Bearer`. `createAuthenticatedFetch` and
`{{integration-token:name}}` keep working beside the client.

### MCP server

An MCP server you added to the org is a credential with `callTool`:

```ts
const linear = await credential('linear')
const result = await linear.callTool('create_issue', {
	title: 'Nightly build failed',
	teamId: 'ENG',
})
```

The need must declare `kind: "mcp"`. Set the server's provider with
`credentialUpdate` so it auto-resolves.

### URL

For services whose secret is the URL itself, such as a Telegram bot
(`https://api.telegram.org/bot<token>`) or a chat webhook. Code passes only a
path and query; Kody appends them to the stored URL.

```ts
const alerts = await credential('alerts-bot')
await alerts.fetch('/sendMessage', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ chat_id: chatId, text: 'Deploy finished' }),
})
```

The stored URL must be HTTPS and on one of the credential's hosts. A path cannot
name another origin or climb out of the stored path. A URL client returns
redirects as they are instead of following them.

### Login

For services that trade a username and password for a session token. Kody stores
the login fields, runs the exchange itself, and places only the session token
(in a header by default, or a query parameter). The login response never reaches
code.

```ts
const reports = await credential('acme-reports')
const response = await reports.fetch('https://api.acme.example/v1/reports')
```

The credential's `login_exchange` says how to log in: the exchange `url` (on one
of the credential's hosts), `bodyFormat` (`json` or `form`), a `body` template
where `{field}` is replaced by a login field, and `tokenPath`, the dot path to
the token in the JSON response.

### Signing

For APIs that want a signed JWT or an HMAC. Code gets the signature, never the
key.

```ts
const appleMusic = await credential('apple-music')
const token = await appleMusic.sign({
	type: 'jwt',
	algorithm: 'ES256',
	header: { kid: keyId },
	claims: { iss: teamId, iat: now, exp: now + 3600 },
})
await fetch('https://api.music.apple.com/v1/catalog/us/songs/203709340', {
	headers: { Authorization: `Bearer ${token}` },
})
```

```ts
const signature = await partner.sign({
	type: 'hmac',
	algorithm: 'hmac-sha256',
	message: body,
	encoding: 'hex',
	prefix: 'sha256=',
})
```

JWTs support `RS*`, `PS*`, `ES*`, `EdDSA` (PKCS#8 PEM private keys), and `HS256`
/ `HS384` / `HS512`. Kody signs only for one of the credential's hosts; pass
`host` to pick one, or it uses the first exact host.

## Creating credentials

Your agent sends a creation link, and you paste the value into the page, never
into chat. Links carry your org in the path:

```txt
https://kody.codes/@acme/-/credentials/new?kind=url&name=alerts-bot&provider=telegram&allowedHosts=api.telegram.org
```

`kind` preselects a kind; add `kindMode=required` to lock it. `name`,
`provider`, `description`, and `allowedHosts` prefill the form. The page saves
Key, URL, login, and signing credentials in place, and hands OAuth and MCP
servers to their own connect flows. The **Add credential** button on the
Credentials page opens the same form.

Code that already holds a value (a key the package just minted) can store it
with `secretSet`, which also takes `kind`, `hosts`, `login_exchange`,
`provider`, and `inject`. Whoever supplies a value decides where it may go, so
`kind` and `hosts` are set together with the value.

## Picking a credential

You can have several credentials for the same provider, such as `work` and
`personal`. When code calls `credential(key)`, Kody uses the first of these that
applies:

1. The caller's credentials map for this run.
2. A stored mapping for the trigger that started the run.
3. Your default mapping for the package, then the org's default.
4. The one credential you can Use that matches the need.

Kody never guesses between two matches. Zero matches is `credential_unbound` and
two or more is `credential_ambiguous`.

Pass a map on `execute`, for ad hoc code or an `invoke`:

```json
{
	"invoke": "kody:@you/pr-digest/summarize",
	"credentials": {
		"github": "work",
		"slack": { "name": "work", "scope": "org" }
	}
}
```

A string picks by name, and an object adds `scope` when an org and a personal
credential share a name. For a `multiple` need, an array picks several for
`credentials(key)` (`"google": ["work", "personal"]`), and `[]` picks none on
purpose. In an `invoke`, a key that no package in the run declares fails the run
with `credential_need_unknown`; ad hoc code only gets a warning. The CLI takes
the same picks:

```bash
npx @kodycodes/cli execute --invoke kody:@you/pr-digest/summarize \
  --credential github=work --credential slack=org:work
```

A pick grants nothing. It chooses only among credentials you can already Use.
Running code through a client needs your Use on the credential; a package's
identity never grants access on its own.

Defaults and trigger mappings are stored per package. Agents propose changes
with `credentialMappingPropose`; you approve them on the package's approval page
or its **Credentials** tab.

### Errors

Every credential error is structured: it has a `code`, a message, and
`retryWith`, a list of ready-to-retry picks.

| Code                      | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `credential_unbound`      | No credential you can use matches the need                 |
| `credential_ambiguous`    | More than one matches; `options` lists them by name/scope  |
| `credential_not_found`    | The named credential is missing or not usable by you       |
| `credential_need_unknown` | The map names a key no package in the invoked run declares |
| `credential_denied`       | Authorization failed                                       |
| `host_not_allowed`        | The request's host is not one of the credential's hosts    |
| `insecure_transport`      | The request is not HTTPS                                   |

When a need has no usable credential, or more than one, the error carries
`createUrl`: a link to the creation page prefilled for that need, so an agent
can hand you a link instead of a bare error. A name that matches nothing
(`credential_not_found`) carries one too.

```ts
try {
	const github = await credential('github')
} catch (error) {
	if (error.code === 'credential_ambiguous') {
		// error.options: [{ name: 'work', scope: 'org', … }, { name: 'personal', … }]
		// error.retryWith: [{ credentials: { github: { name: 'work', scope: 'org' } } }, …]
	}
	if (error.code === 'credential_unbound') {
		// error.createUrl: https://kody.codes/@acme/-/credentials/new?provider=github&…
	}
	throw error
}
```

`credential.named(name)` picks by exact name in ad hoc code and in unshared
packages in your personal org. Shared packages declare needs instead.

## Webhook verification

Inbound webhooks verify the sender before any package code runs. Declare it on
the webhook in `kody.webhooks`.

A provider that signs deliveries with a signing secret it issued (Sentry,
Stripe) uses a Key named by `secretName`:

```json
"verification": {
	"type": "hmac-sha256",
	"header": "sentry-hook-signature",
	"secretName": "sentryWebhookSecret",
	"encoding": "hex"
}
```

Omit `secretName` for GitHub-style hooks where Kody mints the signing secret
onto the webhook URL itself. A sender that cannot sign uses the secret path
segment of the minted URL as its credential:

```json
"verification": { "type": "url-secret" }
```

Treat a minted webhook URL like any other credential. Details:
[Inbound webhooks](../use/webhooks.md).

## Personal credentials

A Key, OAuth connection, or MCP server in your personal org is a personal
credential. Grant it to a team org with `credentialOrgGrant`. It then works in
that org only in your own runs, through `credential(key)`; nobody else there can
use it, Owners included, and `{{secret:name}}` placeholders never resolve it.
`credentialOrgRevoke` removes the grant.

## Not available yet

- Using a personal MCP server through `credential()`. Add the MCP server to the
  org instead.
- A credential picker for visitors of a package app. Apps auto-resolve the
  signed-in visitor's single match; grant Use to the role that needs it.
- A `verify` operation on signing credentials for inbound webhooks. Keys verify
  webhooks.
- Declaring OAuth scopes on a need. A missing scope shows up as a 401 or 403
  with `x-kody-credential-hint`.

## Where to go next

- [Secrets](./secrets.md): the Key kind in depth, host and package approval, and
  expiry.
- [Secrets and host approval](../use/secrets-and-values.md): MCP-level reference
  for placeholders, `secretSet` fields, and personal grants.
- [Packages](../use/packages.md): the full `kody.credentials` and `credential()`
  reference.
- [OAuth](./oauth.md) and [MCP servers](../use/mcp-client-servers.md): connect
  each kind.
- [ADR 0068](../contributing/decisions/0068-credentials-own-placement-scoped-clients.md):
  the design record for the credentials model.
