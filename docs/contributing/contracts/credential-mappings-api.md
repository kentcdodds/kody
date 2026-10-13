# Credential mappings, approval, and creation links contract

Contract between the non-UI half (data model, APIs, runtime errors) and the UI
half (creation one-pager, credentials list, package Credentials / Default
mappings / Triggers tabs, approval page) of the credentials UX build. It builds
on [ADR 0068](../decisions/0068-credentials-own-placement-scoped-clients.md),
including the 2026-10-12 amendments and the
[credential mappings amendment](../decisions/0068-credentials-own-placement-scoped-clients.md#amendment-2026-10-13-credential-mappings).

"Credentials" is the umbrella term: Keys (today's secrets), OAuth integrations,
MCP servers, and the opt-in `url`, `login`, and `signing` kinds are all
credentials.

Shapes here are the API contract. The TypeScript types and URL codecs live in
[`credential-contracts.ts`](../../../packages/worker/universal/credential-contracts.ts)
so the client and the server import the same definitions; its test holds sample
payloads for UI fixtures.

## Rules every surface keeps

- No surface returns, logs, or displays a credential value.
- A mapping never grants anything. A run still needs the actor's Use on the
  mapped credential (plus `package:execute`), checked at run time.
- Every option list holds only credentials the viewer can Use.
- Agents can only **propose** mappings. A proposal takes effect only when a
  signed-in person clicks Approve on the approval page.
- Key placeholders (`{{secret:NAME}}`, `{{integration-token:NAME}}`) are
  unaffected by mappings and keep working exactly as they do.
- Hosted and `--local` runs resolve mappings the same way (the host resolves;
  values never reach the local machine).

## Vocabulary

| Term              | Meaning                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Need              | One key of a package's `kody.credentials` closure (`key`, optional `kind`, `provider`, `description`, `multiple`).                                                 |
| Credential ref    | `{ id, name, scope, kind }`. `scope` is `org` (owned by the org) or `personal` (the viewer's own credential granted to this org).                                  |
| Mapping           | The ordered credential refs chosen for one need. `[]` means "none on purpose". At most one ref unless the need is `multiple` (then at most 16).                    |
| Default mapping   | A package's ad hoc default for one need. Two layers: `org` (set by a package manager, org credentials only) and `mine` (the viewer's own override).                |
| Trigger instance  | One declared trigger of a package as one person runs it: a schedule (`cron`, `kody.jobs`), a `subscription` topic, or a minted `webhook`. Backed by an enablement. |
| Trigger mapping   | A per-instance override for one need. A need with no override inherits the enabler's default mapping.                                                              |
| Effective mapping | What a run would use for a need right now, with where it came from.                                                                                                |

## Resolution order

For `credential(key)` in a package run, the first step that yields a mapping
wins:

1. **Call map** entry (`credentials` on `execute` / `packageInvoke` / the CLI;
   interactive runs only, see #3599).
2. **Trigger mapping** of the enablement the run acts as (trigger runs only).
3. **Default mapping**, `mine` layer, then `org` layer.
4. **Auto-resolve**: exactly one candidate (ADR 0068 resolution rule 3).

Unusable refs:

- In a trigger mapping, a ref the enabler has lost Use on (deleted, Use revoked,
  personal grant removed) is a `credential_not_found` error for that run. It
  never falls through to another credential.
- In a default mapping, refs the actor cannot Use are skipped; a layer with no
  usable ref counts as absent and resolution continues with the next step. This
  keeps an org default to a shared bot credential from breaking members who lack
  Use on it while still letting them auto-resolve their own.
- `[]` at any step stops resolution: the need is unbound on purpose
  (`credential_unbound`, with a creation link).

## Shared types

```ts
export const credentialKinds = [
	'secret',
	'oauth',
	'mcp',
	'url',
	'login',
	'signing',
] as const
export type CredentialKind = (typeof credentialKinds)[number]
export type CredentialScope = 'org' | 'personal'

export type CredentialRef = {
	id: string
	name: string
	scope: CredentialScope
	kind: CredentialKind
}

/** A pick as an agent or a form sends it: by name (optionally scoped) or id. */
export type CredentialPick =
	{ name: string; scope?: CredentialScope } | { id: string }

export type CredentialMappingLayer = 'org' | 'mine'

export type CredentialTriggerKind = 'cron' | 'subscription' | 'webhook'
export type CredentialTriggerRef = { kind: CredentialTriggerKind; name: string }

export type StoredCredentialMapping = {
	/** `[]` is "none on purpose". */
	credentials: Array<CredentialRef>
	/** Refs the viewer can no longer Use (deleted or Use revoked); ids only. */
	unusableIds: Array<string>
	updatedAt: string
	updatedBy: { username: string } | null
}

export type CredentialMappingSource =
	'call' | 'trigger' | 'mine' | 'org' | 'auto' | 'none'

export type EffectiveCredentialMapping = {
	source: CredentialMappingSource
	/**
	 * - `ready`: a run would use `credentials`.
	 * - `none`: mapped to `[]` on purpose; the need is unbound.
	 * - `unbound`: nothing mapped and no candidate.
	 * - `ambiguous`: nothing mapped and several candidates (`candidates`).
	 * - `unusable`: a trigger mapping names a credential the enabler cannot Use.
	 */
	status: 'ready' | 'none' | 'unbound' | 'ambiguous' | 'unusable'
	credentials: Array<CredentialRef>
	candidates: Array<CredentialRef>
	/** Absolute creation link; set when status is not `ready`. */
	createUrl: string | null
}

export type CredentialMappingTarget =
	| { type: 'default'; layer: CredentialMappingLayer }
	| { type: 'trigger'; trigger: CredentialTriggerRef }

export type CredentialMappingChange = {
	target: CredentialMappingTarget
	needKey: string
	/** `null` clears the override (inherit); `[]` is "none on purpose". */
	credentials: Array<CredentialPick> | null
}
```

## Credential creation link

```
GET /connect/credential?kind=<kind>&kindMode=hint|required&...
```

Agents hand people this link the way they hand out `/connect/secret-set` and
`/connect/oauth` today. Runtime errors build it (see
[Runtime errors](#runtime-errors)).

| Param                | Meaning                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`               | One of `credentialKinds`. Absent: the chooser starts on `secret`.                                                                                                                                                      |
| `kindMode`           | `hint` (default): `kind` is preselected and the kind chooser is shown. `required`: the kind is locked and no chooser is shown. Ignored without `kind`.                                                                 |
| `name`               | Prefilled credential name.                                                                                                                                                                                             |
| `provider`           | Prefilled provider slug (`^[a-z0-9-]+$`).                                                                                                                                                                              |
| `description`        | Prefilled description.                                                                                                                                                                                                 |
| `allowedHosts`       | Prefilled hosts, comma separated or repeated (same as `/connect/secret-set`).                                                                                                                                          |
| `forPackage`, `need` | The package (kody id) and need key this credential is for. After saving, the page offers the approval link that maps it as the default. (`package` is taken: `/connect/secret-set` reads it as an allowed package id.) |
| anything else        | Passed through unchanged to the reused form: `/connect/secret-set` params (`scope`, `packageId`, `expiresAt`, `allowedPackages`) or `/connect/oauth` params (`authorizeUrl`, `tokenUrl`, `scopes`, `flow`, ...).       |

The page body reuses the existing secret-intake form for `secret`, `url`,
`login`, and `signing`, the OAuth connect form for `oauth`, and the MCP server
add form for `mcp`.

Until the one-pager ships, the server answers `/connect/credential` with a 302
to the existing page for the kind, carrying the same query:

- `secret` or no kind: `/connect/secret-set`. Saving there also stores
  `provider` from the link, so the new Key auto-resolves for the need.
- `oauth`: `/connect/oauth`. When a built-in OAuth app exists for the provider,
  runtime links add `platform=<slug>` so that page opens the built-in app.
- `mcp`: `/@<org>/-/mcp-servers`.
- `url`, `login`, `signing`: the existing forms cannot create these kinds, so
  the redirect goes to `/@<org>/-/secrets` without a prefilled form. Runtime
  errors for these kinds also tell the agent to create the credential with
  `secretSet` and that `kind`.

Links built today keep working when the one-pager replaces the redirect.

Codecs: `buildCredentialCreateHref(input)` and
`parseCredentialCreateQuery(url)`.

## Credentials list API

```
GET /account/credentials.json?q=&kind=&scope=&packageScoped=&locked=
```

Session-authenticated (website), for the current org binding. The MCP / Open API
twin is the `credentialList` capability (`GET /v1/credentials`, with `kinds` in
place of `kind`) taking the same filters and returning the same `credentials`
array.

| Filter          | Values                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| `q`             | Case-insensitive substring of name, provider, description, or host.                   |
| `kind`          | One of `credentialKinds`; repeatable.                                                 |
| `scope`         | `org` or `personal`.                                                                  |
| `packageScoped` | `true`: only package-scoped Keys; `false`: exclude them.                              |
| `locked`        | `true`: only credentials locked to packages; or a package id: locked to that package. |

```ts
export type CredentialListItem = {
	id: string
	kind: CredentialKind
	name: string
	scope: CredentialScope
	provider: string | null
	description: string
	hosts: Array<string>
	/** Placement through a scoped client; null when the kind has none. */
	inject:
		| { kind: 'header'; name: string; format: string }
		| { kind: 'basic'; valueAs: 'username' | 'password'; other: string }
		| { kind: 'query'; param: string }
		| null
	/** Package-scoped Key: the package it belongs to. */
	packageId: string | null
	/** Non-empty when locked to these packages (allowed packages / usage mode). */
	lockedToPackageIds: Array<string>
	expiresAt: string | null
	createdAt: string
	updatedAt: string
	status: 'ok' | 'expired' | 'needs_attention' | 'disabled'
	statusMessage: string | null
	/** MCP servers only. */
	mcp: { url: string; enabled: boolean } | null
}

export type CredentialListResponse = {
	ok: true
	credentials: Array<CredentialListItem>
}
```

- MCP servers are listed with `kind: 'mcp'`, `hosts: [<server hostname>]`, and
  `mcp.url`. Their `status` comes from stored state (enabled flag, last error),
  not a live connection probe.
- Session-scoped Keys are not listed.
- `scope: 'personal'` rows are the viewer's own personal credentials granted to
  this org. Nobody else's personal credentials appear.
- Org binding works like the other org-owned account JSON: a same-origin fetch
  from an `/@slug/-/…` page binds that org, and the Secrets section gate
  applies. Without such a Referer the signup org is used.
- Org rows follow the viewer's grants: Keys need `secret:use`; OAuth and MCP
  rows need `integration:read` (org-wide or granted on that credential).
- Package code cannot call `credentialList`.

## Package credentials API

```
GET  /profiles/:username/packages/:kodyId/credentials.json
POST /profiles/:username/packages/:kodyId/credentials.json
```

Feeds the package Credentials, Default mappings, and Triggers tabs. Requires
`package:execute` on the package; anything else is a 404.

```ts
export type PackageCredentialNeedView = {
	key: string
	/** Null when the manifest omits `kind` (any fetch-capable kind). */
	kind: CredentialKind | null
	provider: string
	description: string
	multiple: boolean
	/** The dependency that declared an inherited need. */
	from?: string
	defaults: {
		org: StoredCredentialMapping | null
		mine: StoredCredentialMapping | null
	}
	/** What an interactive run by the viewer would use. */
	effective: EffectiveCredentialMapping
	/** What the viewer may pick for this need. */
	options: Array<CredentialRef>
	/** Always set: the creation link for this need. */
	createUrl: string
}

export type PackageTriggerView = {
	trigger: CredentialTriggerRef
	/** Webhook endpoint id, job id, or package id; null for an unminted webhook. */
	instanceId: string | null
	/** The viewer's enablement, or the webhook's single enabler. */
	enablement: {
		id: string
		state: 'on' | 'paused' | 'off'
		enabledByYou: boolean
	} | null
	/** Only the enabler edits; true when the viewer is (or would become) it. */
	canEdit: boolean
	mappings: Array<{
		needKey: string
		override: StoredCredentialMapping | null
		effective: EffectiveCredentialMapping
	}>
}

export type PackageCredentialsView = {
	ok: true
	package: { id: string; kodyId: string; canManage: boolean }
	needs: Array<PackageCredentialNeedView>
	triggers: Array<PackageTriggerView>
	/** Credentials locked to this package, plus its package-scoped Keys. */
	locked: Array<CredentialListItem>
	/** Every need, per default and per trigger, whose effective status is not `ready` or `none`. */
	incomplete: Array<{
		needKey: string
		where:
			{ type: 'default' } | { type: 'trigger'; trigger: CredentialTriggerRef }
		status: 'unbound' | 'ambiguous' | 'unusable'
	}>
}
```

`POST { changes: Array<CredentialMappingChange> }` applies edits made directly
on the website (a person editing a tab) and returns the updated
`PackageCredentialsView`. It uses the same validator and writer as Approve and
is atomic: every change applies, or none does (`400 { ok: false, errors }`).
This endpoint is session-only; MCP and API tokens cannot reach it.

Who can write:

| Target             | Allowed                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` / `org`  | Package managers. Refs must be org credentials the writer can Use.                                                                                                                      |
| `default` / `mine` | Anyone with `package:execute`. Refs must be credentials they can Use.                                                                                                                   |
| `trigger`          | The enabler only. Writing a trigger mapping for a trigger the writer has not enabled turns it on for them (webhooks must be minted first; a webhook another person enabled is refused). |

Validation per change: the need exists in the published closure; each ref exists
and the writer can Use it; kind matches when the need declares one (otherwise
any fetch-capable kind, the same set as ADR 0068 resolution rule 1: `secret`,
`oauth`, `login`); provider matches when both sides have one; at most one ref
unless `multiple`.

## Mapping proposals and the approval page

### Proposal URL

```
GET /@:username/:kodyId/approve-credentials?<proposal>
```

`<proposal>` is a query string an agent can build by hand:

| Param                            | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `default[<need>]`                | Org-layer default mapping for `<need>`.                                |
| `mine[<need>]`                   | The approver's own default mapping for `<need>`.                       |
| `trigger[<kind>:<name>][<need>]` | Trigger mapping for the approver's instance of a trigger.              |
| `reason`                         | Optional agent note (at most 500 characters), shown as untrusted text. |

Each mapping param is repeatable, one value per credential:

- `work` (name), `org:work` or `personal:work` (scoped name), or
  `id:<credentialId>`. A name that itself starts with `org:`, `personal:`,
  `id:`, or `name:` is written `name:<name>` (`name:id:abc` is the credential
  named `id:abc`).
- A single empty value (`default[github]=`) maps the need to `[]`. An empty
  value beside other values, or a value that is not a valid pick (`org:`), is a
  proposal error, never `[]`.
- Inside the brackets, `%`, `[`, and `]` in a need key or trigger name are
  percent-encoded a second time (`%25`, `%5B`, `%5D`), so a cron job named
  `daily]backup` is `trigger[cron:daily%5Dbackup][github]` after query decoding.
  The codecs do this; hand-built links only need it for those three characters.

At most 64 mapping params (a param's repeated values count once). Param names
that decode to the same target and need (`default[github]` and
`default[git%68ub]`) are one param. Example:

```
/@acme/pr-digest/approve-credentials?default[github]=org:acme-bot&trigger[cron:daily][slack]=team-slack&reason=Daily%20digest%20posts%20to%20Slack
```

Codecs: `buildCredentialApprovalHref(input)` and
`parseCredentialApprovalQuery(url)`.

### Approval API

```
GET  /profiles/:username/packages/:kodyId/approve-credentials.json?<proposal>
POST /profiles/:username/packages/:kodyId/approve-credentials.json?<proposal>
```

```ts
export type CredentialApprovalErrorCode =
	| 'need_unknown'
	| 'trigger_unknown'
	| 'credential_not_found'
	| 'credential_ambiguous'
	| 'kind_mismatch'
	| 'provider_mismatch'
	| 'too_many'
	| 'not_allowed'
	| 'webhook_not_minted'
	| 'webhook_other_enabler'

export type CredentialApprovalChangeView = {
	target: CredentialMappingTarget
	needKey: string
	need: {
		kind: CredentialKind | null
		provider: string
		description: string
		multiple: boolean
	} | null
	/** The stored override today; null means it inherits. */
	before: Array<CredentialRef> | null
	after: Array<CredentialRef>
	/** Approving turns this trigger on for the approver. */
	willEnable: boolean
	error: {
		code: CredentialApprovalErrorCode
		message: string
		createUrl?: string
	} | null
}

export type CredentialApprovalView = {
	ok: true
	package: { id: string; kodyId: string }
	reason: string | null
	/** False when any change has an error or the proposal has parse errors. */
	canApprove: boolean
	/** Pins what was reviewed: changes resolved to credential ids. */
	fingerprint: string
	changes: Array<CredentialApprovalChangeView>
	/** Proposal-level problems (bad param names, too many params). */
	errors: Array<string>
}
```

- `GET` resolves the proposal for the signed-in viewer and returns
  `CredentialApprovalView`. It never writes.
- `POST { action: 'approve', fingerprint }` re-resolves the same query. A
  different fingerprint (a credential was renamed or replaced, or a mapping
  changed since review) is `409 { ok: false, error, view }` with the fresh view.
  Otherwise every change (and any trigger it enables) is written in one batch:
  `{ ok: true, view }`.
- One Approve applies trigger mappings and default mappings together.

### `credentialMappingPropose` (MCP / Open API)

Input:

```ts
{
	packageId?: string
	kodyId?: string
	defaults?: Record<string, CredentialPick | Array<CredentialPick>>
	mine?: Record<string, CredentialPick | Array<CredentialPick>>
	triggers?: Array<{
		kind: CredentialTriggerKind
		name: string
		credentials: Record<string, CredentialPick | Array<CredentialPick>>
	}>
	reason?: string
}
```

Output: `{ approvalUrl, view: CredentialApprovalView, message }`. It validates
as the caller would approve and returns the absolute approval URL to send to the
person. It never writes. `view.canApprove: false` lists what to fix first.

## Runtime errors

`CredentialClientError` bodies (`credential()` in package and ad hoc code, CLI
local, CapabilityProxy) gain:

```ts
export type CredentialClientErrorBody = {
	code: CredentialClientErrorCode
	message: string
	retryWith: Array<CredentialClientRetry>
	options?: Array<CredentialClientOption>
	possibleMatches?: Array<CredentialClientOption>
	/** Absolute creation link. Always set for credential_unbound and credential_not_found. */
	createUrl?: string
}
```

- The message ends with `Create one at <createUrl>` so agents that only read the
  message still get the link.
- `credential_unbound` for a need that declares `kind` links with
  `kindMode=required`; for a need without `kind` it links with `kindMode=hint`
  (`oauth` when a platform OAuth app exists for the provider, plus
  `platform=<slug>`; else `secret`). `provider`, `name` (the need key),
  `description`, `forPackage`, and `need` are prefilled.
- For a need that declares `url`, `login`, or `signing`, the message also says
  to create it with `secretSet` and that `kind`, since the website cannot create
  those kinds until the one-pager ships.
- `credential_not_found` for `credential.named(name)` links with `name`
  prefilled and no kind.
- A missing `{{secret:NAME}}` placeholder in a run keeps its `secret_required`
  details; its `nextStep` points at the creation link
  (`/connect/credential?kind=secret&kindMode=required&name=NAME`).

## Redirects

When the credentials list page ships, these old URLs redirect (302, query
preserved) instead of 404ing:

| Old                         | New                                               |
| --------------------------- | ------------------------------------------------- |
| `/@:org/-/secrets`          | `/@:org/-/credentials?kind=secret`                |
| `/@:org/-/integrations`     | `/@:org/-/credentials?kind=oauth`                 |
| `/@:org/-/mcp-servers`      | `/@:org/-/credentials?kind=mcp`                   |
| `/@:org/-/secret-providers` | `/@:org/-/credentials` (custom providers section) |
| `/connect/secret-set`       | `/connect/credential?kind=secret&...`             |

Only index pages redirect. Deeper paths that are approval or OAuth flows
(`/@:org/-/secrets/approve`, `/@:org/-/mcp-servers/:serverId/authorize`,
`/account/mcp-servers/oauth/callback`) keep serving. `/connect/oauth` never
redirects: it is the registered OAuth redirect URI for bring-your-own apps.
`credentialRedirectFor(url)` returns the new URL or null so the router and tests
share one table. Legacy `/connect/secret-set` links read `package` as an allowed
package id, so the redirect renames it to `allowedPackages` (the creation link
uses `forPackage` for the package a need belongs to).

## Build order

Each step is a small PR stacked on the previous one:

1. This contract and the ADR amendment.
2. `universal/credential-contracts.ts`: types and URL codecs, with tests.
3. Runtime errors carry `createUrl`; `/connect/credential` interim redirect.
4. Credentials list API and `credentialList` (MCP servers included).
5. Mapping storage (additive migration) and resolution in `credential()`.
6. Package credentials API.
7. Proposal capability and approval API.
8. Redirect table.
