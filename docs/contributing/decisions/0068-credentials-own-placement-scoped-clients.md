# 0068: Credentials own placement; scoped clients replace slots and assignments

- **Status:** accepted
- **Date:** 2026-10-11
- **Amended:** 2026-10-12 (Kent: today's secrets are the Key credential type and
  keep working permanently; the other types are opt-in; by-name grants stay; no
  old-lane removal; integration-token placeholders are permanent; the webhook
  no-actor exception stays unless a proven replacement breaks nothing);
  2026-10-12 (Kent: manifest credential need `kind` is optional — see
  [Amendment 2026-10-12](#amendment-2026-10-12))
- **Supersedes in part:** [0021](./0021-publish-gated-package-composition.md)
  (credential authority for the opt-in types used through scoped clients), and
  credentials plan v4 section 3.3 (assignments) and section 3.4 (placeholder
  grammar). The v4 plan lives outside this repo.

This record is the source of truth for the credentials model. Credentials plan
v4 still holds for personal credentials (3.2), enablements, the one
`resolveCredential` door, audit, and leak tests, except where this record
changes them. The rule is: do not break people while improving things for the
future. Key credentials (today's secrets and their placeholders) keep working
exactly as they do, with the authority rules of the records this one supersedes
in part.

## Context

Package code reaches credentials through `{{secret:NAME}}` and
`{{integration-token:NAME}}` placeholders. The fetch gateway fills them anywhere
in an HTTPS request to an allowed host: headers, the URL path and query, and
text bodies. Code therefore decides where a value goes. Echo redaction is
exact-match and covers only the response to the same fetch, so it cannot close
that class on its own.

Plan v4 answered with manifest slots (`kody.credentials`), org assignments of a
credential to each slot (3.3), and a placeholder grammar keyed by slot (3.4).
Assignments add a mapping table, saved bindings, and a package-level grant that
stands in for the actor's Use. This record replaces that with credentials that
own their hosts and placement, and a scoped client as the surface for the new
credential types.

The first version of this record also retired placeholders at a cutover. Kent
amended it on 2026-10-12: placeholders are the Key type and stay, and the new
types are more secure options that owners opt into.

Baseline: [#3210](https://github.com/kentcdodds/kody/pull/3210) (`77a82ed3`)
requires the actor's Use on CLI local execute even when a package id is stamped,
and [#3169](https://github.com/kentcdodds/kody/pull/3169) (`0d140d22`) enforces
per-resource Use when resolving org credentials. This record builds on both.

## Decision

In short:

- **Key** is today's secret, and it keeps working permanently: placeholders fill
  anywhere in an HTTPS request to one of its allowed hosts. There is no cutover
  that removes it.
- The other types (`header` / `basic` / `query` inject through a scoped
  `credential(key)` client, OAuth through a client, `url`, `login`, and
  `signing`) are more secure options, not a forced migration. With them a
  credential owns its hosts and placement (never the body) and code never
  decides where a value goes.
- Through a scoped client, the actor's Use plus `package:execute` is the only
  authority and package stamps grant nothing.
- Callers pick among candidates with a call map; triggers store the pick in an
  enablement. Zero or several candidates is a structured error, never a default.
- Slots as grants, assignments, and saved bindings are not built. By-name grants
  stay. Nothing is scheduled for removal.

The sections below are the full specification.

### Primitives

There are four:

1. **Credential.** An org-owned or user-owned secret, OAuth connection, or MCP
   server. It owns its hosts and how its value is placed in a request.
2. **Resolver.** One per credential kind, all behind the one `resolveCredential`
   door.
3. **Scoped client.** The credential surface for the opt-in types. Key
   placeholders stay beside it.
4. **Enablement.** The only persisted credential choice, used for triggers
   (cron, subscription, webhook) that have no live caller.

There are no mapping or assignment tables and no saved bindings. Key
placeholders, package allowlists, and usage modes stay (see
[Key credentials](#key-credentials)).

### Key credentials

Key is the credential type for today's secrets, and it keeps working exactly as
it does, permanently:

- `{{secret:NAME}}` placeholders fill anywhere in a request (a header, the URL
  path or query, or a text body) when the request is HTTPS and its host is one
  the secret allows.
- `{{integration-token:NAME}}` placeholders are permanent too, and fill the same
  way on the integration's allowed hosts. OAuth through a scoped client is an
  opt-in option beside them, not a replacement.
- `kody.secretMounts`, `packageSecrets`, `|scope=`, webhook `secretName`,
  `x-kody-secret-resolution`, package allowlists, usage modes, provider grants,
  and today's package authority rules
  ([0021](./0021-publish-gated-package-composition.md)) keep working.
- Body, other, and computed placements are fine. Publish, `packageGet`, and
  `repoRunChecks` never warn in a way that implies breakage. Where a more secure
  type fits a placement, they may gently suggest it (see
  [Which more secure type fits](#which-more-secure-type-fits)).
- A Key can also be used through `credential(key)`, which places it by its
  `inject` rule. The same Key keeps filling placeholders.

### Resolver interface

- `resolve(need, pick, actor)` returns
  `handle | unbound | ambiguous | not_found`. The handle holds metadata only,
  never a value.
- `authorize(handle, request)` returns
  `ok | host_not_allowed | insecure_transport | denied`. It checks the actor's
  org access (cached for about 60 seconds, then checked again), the actor's Use
  on the credential, a live org grant for a personal credential, that the host
  is in the credential's `hosts`, and that the request is HTTPS.
- `apply(handle, request)` injects the credential. It runs only in the gateway
  and only after `authorize` returns `ok`. It is the only step that reads a
  value, so a refused host never triggers a token refresh. For `signing`, it
  produces a signature.
- `audit(outcome)` writes one row per resolution, including denials: person,
  oauthClientId, package, need key, credential id, and outcome. Never a value.

Kinds: `secret` (Key), `oauth`, and `mcp` (the `mcp` client exposes `callTool`,
not `fetch`). Later kinds are new resolvers in the same door, not new lanes, and
owners opt into them:

- `login`: the gateway runs the login exchange and injects only the session
  token; the login response never reaches code.
- `url`: a whole-URL secret pinned to its own host, over HTTPS.
- `signing`: signs requests (a JWT or an HMAC) for one of its hosts; code gets
  the signature, never the key. Today's webhook verification keeps working with
  Keys; a `verify` operation can be added if an owner wants a signing-type
  webhook secret.

### Credential fields

```
{ id, ownerKind: 'org'|'user', kind, provider: slug|null, name, hosts[], inject, source: 'stored'|{ vault, ref } }
```

`inject` decides placement when a credential is used through a scoped client
(Key placeholders keep their own placement). It never places a value in the
body. It is one of:

- `header{ name, format }`. The default is `Authorization: Bearer {value}`.
  OAuth credentials always use Bearer.
- `basic{ valueAs: 'username'|'password', other?: string }`. `other` is a
  non-secret literal and defaults to `''`. When both parts are secret, use the
  `login` kind.
- `query{ param }`.

There is no `pathPrefix`; `/bot<token>/` style URLs use the `url` kind.

The creator sets `hosts` and `inject` (usually an agent through `secretSet` or
the connect page). Only the credential's manager edits them (the owner, for a
personal credential), and every edit is audited. Nothing in a manifest hints at
or pre-fills them.

Hosts: no hosts denies every request; entries are exact hosts or a wildcard at
most one level deep (`*.example.com`); HTTPS only; redirects are followed
manually and authorized again on every hop. A `url` credential owns its whole
URL, so its client returns redirects unfollowed.

Personal credentials follow plan v4 3.2: user-owned, granted to orgs one org at
a time, never usable by Owners or Automation on someone else's behalf. A
personal OAuth credential minted through an org's OAuth app is pinned to that
org. The owner manages grants with `credentialOrgGrant`, `credentialOrgRevoke`,
and `credentialOrgGrantList` (live person and Write on the credential to change
one; audited in the owner's personal org).

### Use grants (`accessGrant` / `accessRevoke`)

`accessGrant` and `accessRevoke` keep accepting secret and integration names and
resolve each name to a credential id at grant time. Granting and revoking by
credential id is added alongside. By-name grants (including grant invites and
`accessList` filters) stay permanently; they are not slated for removal.

Use on a vault's door-key secret does not cover the vault, which is its own
credential. Nothing is left to remove there.

### Manifest (`kody.credentials`)

The keyed map stays. `provider` is optional and defaults to the key.
`description` is required. `kind` is optional (see
[Amendment 2026-10-12](#amendment-2026-10-12)).

```json
"credentials": {
  "github":     { "description": "Read PRs to summarize them" },
  "github_bot": { "kind": "oauth", "provider": "github", "description": "Bot account" },
  "google":     { "kind": "oauth", "multiple": true, "description": "Calendars" }
}
```

- Publish warns (does not fail) when a key is not a provider slug
  (`^[a-z0-9-]+$`).
- A second account from the same provider gets its own key with an explicit
  `provider`. There is no `as` field.
- Omitting `kind` means any fetch-capable credential for that provider (Key /
  secret such as a PAT, oauth, or login). The `credential()` client picks the
  code path (inject header, OAuth refresh on 401, login exchange). Package code
  is identical for PAT vs OAuth. Declare `kind` only when a specific shape is
  needed (`signing` for `sign()`, `mcp` for `callTool()`, `url`, or a
  provider/feature that truly requires one kind, such as oauth for Google user
  data). A declared `kind` keeps today's narrowing, so published manifests stay
  valid.
- There is no hosts, inject, or placement field.
- **Needs closure:** the package's needs plus those of its snapshotted
  dependencies (pinned at the dependent's publish, per
  [0001](./0001-no-package-versioning.md)), computed at publish and stored with
  the bundle. A key that conflicts on kind or provider is a publish error.
- `packageGet` tags needs inherited from a dependency with `from`.

### Code API (`kody:runtime`)

- `credential(key)` returns `{ name, scope, kind, hosts }` plus `fetch` (secret,
  oauth, url, login), `callTool` (mcp), or `sign` (signing). A relative URL
  resolves against the credential's first host; an absolute URL must be in
  `hosts`. If code sets the header the credential injects, the gateway
  overwrites it.
- `credentials(key)` returns an array, for `multiple: true` needs.
- An undeclared key (ad hoc execute or author-only code) is treated as the
  provider.
- `credential.named(name)` picks by exact name. It works only in ad hoc execute
  and in unshared packages in a personal org. Sharing (Community listing,
  granting Use, moving into a team org) is refused while `named` remains, and
  `repoRunChecks` lists the call sites. Runtime checks it again.
- Client handles are opaque and scoped to one run. Passing a client to a
  function in an imported package is explicit capability passing.
- SDKs that accept a custom fetch take `fetch: gh.fetch`.

### Call shapes

`packageInvoke` and ad hoc `execute` take a map:

```
credentials: { github: 'work', google: ['work','personal'], x: { name: 'work', scope: 'org' } }
```

The CLI takes `--credential github=work` and `--credential x=org:work`. Enable
takes the same map, resolved once at enable time to credential ids, so ambiguous
or unbound errors surface when enabling. Only the enabler changes the choice
(`enablementUpdate { credentials }`, audited). An admin can disable someone
else's enablement but cannot point it at different credentials.

### Resolution rules

1. **Candidates:** credentials with the need's provider that the actor can Use
   in the run org (org credentials with Use, plus the actor's own personal
   credentials granted to that org). When the need declares `kind`, candidates
   must also match that kind; when `kind` is omitted, any fetch-capable
   credential for the provider qualifies (Key/secret, oauth, login). A null
   provider never auto-resolves.
2. **Map entry:** an exact pick. Kind must match when the need declares one;
   provider must match when both sides have one.
3. **No map entry:** exactly one candidate is used (`[it]` for `multiple`); zero
   is `credential_unbound`; two or more is `credential_ambiguous`. A `multiple`
   need never gets "all of them". An explicit `[]` means none on purpose.
4. **Timing:** map values are validated before code runs. An unknown map key is
   an error in `packageInvoke` and a warning in ad hoc execute or with a dynamic
   `import()`. Needs without a map entry resolve lazily on first use.
5. **Pinning:** the pick is pinned for the run; `authorize` still runs on every
   request.
6. **Authority:** the actor's Use plus `package:execute`, nothing else. Package
   stamps (attested or claimed) never grant anything; they only select which
   needs and storage apply. CLI `--local` stays closed by construction and
   values never reach the local machine.
7. **Name collisions:** an org and a personal credential with the same name
   return `credential_ambiguous` listing both; the caller retries with
   `{ name, scope }`.
8. **Drift:** a need that auto-resolved becomes ambiguous when a second match is
   added, and the error carries a ready-to-retry call. Enablements store ids and
   do not drift. There is never a default credential.

### Errors

Every error is structured and includes `retryWith`.

| Error                                   | Meaning                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `credential_unbound{ possibleMatches }` | No candidate. Lists same-kind credentials with a null provider, filtered by Use. |
| `credential_ambiguous{ options }`       | More than one candidate.                                                         |
| `credential_not_found`                  | Missing or not usable by the actor; one error for both so it reveals neither.    |
| `credential_need_unknown`               | The map names a key the package does not declare.                                |
| `credential_denied`                     | Authorization failed.                                                            |
| `host_not_allowed`                      | The host is not in the credential's `hosts`.                                     |
| `insecure_transport`                    | The request is not HTTPS.                                                        |

A 401 or 403 from a client fetch adds a hint naming only the inject shape (for
example `header Authorization Bearer`), never a value, the hosts, or other
credentials. An explicit pick of a null-provider credential hints "set provider
to X to auto-resolve"; Kody never writes the provider itself.

### Agent read (`packageGet`)

```
credentials.needs[]: {
  key, kind, provider, description, multiple, from?,
  status: 'ready'|'ambiguous'|'unbound',
  autoPick: name|null,
  yourOptions[]: { name, scope: 'org'|'personal', org?, hosts[] }
}
```

Every option and match is filtered by the actor's Use. From T, `packageGet` may
gently suggest a more secure type where one fits a Key placeholder. It never
warns as if the placeholder will break.

### Surfaces

- **Interactive** (MCP, CLI, Open API): the caller supplies the map.
- **Package app:** the signed-in visitor is the actor, with auto-resolve only. A
  platform-rendered picker held in the visitor's browser session, and
  app-service credentials (a later enablement kind with an explicit enabler),
  are deferred until there is demand. Until then, grant Use to the role.
- **Enablements:** each stores credential ids; its runs act as the enabler, who
  is billed and audited. It pauses when the enabler loses Use, a credential is
  deleted, or a republish adds an ambiguous or unbound need, and resumes on its
  own once the cause clears, notifying the enabler. A need added by a republish
  auto-resolves on each run without storing anything, and the publish response
  warns when the package has live enablements. Webhook verification may also go
  through the door with the enablement as the actor. The no-actor exception for
  webhook verification stays unless a proven replacement exists and nothing that
  works today breaks. The webhook URL secret (`url-secret`) is already a
  permanent, explicit verification type.
- **Inbound email:** a member sender is the actor. Mail from a non-member runs
  the inbox owner's enablements.

### Identity and MCP tokens

- Nothing resolves without a `PersonId` actor with a live org binding, except
  the webhook verification no-actor exception, which stays (see Surfaces).
- New OAuth grants require `personId`, stamped at consent the same way
  [0064](./0064-oauth-org-binding.md) stamps `orgId`.
- Legacy grants in a personal org derive the person after a database check (the
  org is personal and that person is its only member). In a team org, a grant
  with no person must re-consent and fails closed until then.
- At P9 the props fallbacks (`orgId ?? userId` and the person fallback) are
  dropped.

### Security properties

- No credential value enters package or user code, logs, errors, or tool output.
- With the opt-in types, code never decides where a value goes. Placement
  belongs to the credential and is never the body. A Key placeholder goes where
  code puts it, on the Key's allowed hosts over HTTPS.
- Publishing, republishing, or forking cannot widen a credential's hosts or
  placement.
- Through a scoped client, the actor's Use is the only grant; CLI `--local`
  stays closed.
- Personal credentials work only in their owner's runs, in orgs the owner
  granted them to.
- Option lists never reveal credentials the actor cannot use.
- Echo redaction stays as defense in depth.
- Remaining risk: a token can do whatever it allows on its allowed hosts. Keep
  hosts narrow and OAuth scopes minimal and visible, and prefer a more secure
  type where one fits.

### Lifecycle

- **Org access ends:** that org's personal grant row is hard-deleted and
  affected enablements pause. OAuth credentials pinned to that org are wiped and
  revoked upstream.
- **Owner deletes a credential:** the value is tombstoned immediately, with no
  restore.
- **Account deleted:** every value is tombstoned at soft delete and never
  restored; rows are purged per [0066](./0066-soft-delete-and-purge.md).
- **Account suspended:** resolution is denied and nothing is wiped.

### Rollout

T is the date the new credential types are available, opt-in: the client API,
call maps (invoke, execute, CLI, enable), `packageGet` needs, the stored needs
closure, and enablement snapshots. Nothing existing changes at T.

**Key behavior (Kent, 2026-10-11, made permanent 2026-10-12):** production keeps
filling placeholders anywhere on allowed hosts over HTTPS. There is no switch to
header-only, before or after T.

**P1 (before T, no visible change):** add `provider`, `inject`, and `source`
columns. Backfill `provider` from OAuth apps and from the slots that reference
each secret. Backfill `inject` from consistent usage in stored package source,
defaulting to Bearer when usage is inconsistent or absent. Ship personal
credentials and org grants (v4 3.2) as backend only: schema, service, and
resolver candidates, with no public capability or UI until T. Stamp `personId`
on new OAuth grants.

**T:** ship the opt-in types above. The `login`, `url`, and `signing` kinds ship
as they are ready; none of them is a prerequisite for anything existing to keep
working.

**Suggested rewrites (optional, owner-approved):** the fleet codemod proposes a
rewrite only when the result behaves identically, as a proposal in the owner's
waiting-for-me list. Nothing is rewritten or republished without the owner's
approval, and declining changes nothing.

- It can propose: a placeholder in a literal header in the `init` object that
  matches the credential's backfilled `inject`, where the credential's hosts
  cover the URL (URLs stay absolute); integration-token placeholders only when
  the header is exactly `Authorization: Bearer`; query placeholders only when
  the backfill found one consistent param; secret basic auth with a literal
  username and a secret password, to `basic{ valueAs: 'password', other }`.
- It proposes nothing for dynamically built headers, a credential used with two
  header shapes, placeholders in the body or path, basic auth where both parts
  are secret, calls that set `x-kody-secret-resolution`, or vault placeholders.
  Those stay as they are, with at most a gentle suggestion of a more secure type
  where one fits.
- An accepted proposal is one revertable commit, republished only when the
  package is clean, has no drift, and passes its checks.
- A proposal may rename a declared key named after a secret (for example
  `RESEND_API_KEY`) to its provider when that provider is unique in the package.
- A proposal may convert a package-scoped value into an org credential named
  `<package-leaf>-<name>` (suffixed if taken), add the matching manifest need,
  and set the credential's provider so it auto-resolves, with `hosts` and
  `inject` from the backfill. The proposal lists the Use grants it would add:
  whoever wrote the value, and in team orgs members who ran the package in the
  last 90 days. Package-scoped values the owner does not convert keep working.

**No old-lane removal (Kent, 2026-10-12):** there is no removal date, rescan
gate, publish refusal of placeholders, window, or owner email. The gateway keeps
parsing placeholders, and by-name grants stay.

**P9:** drop the grant-props fallbacks.

### Which more secure type fits

A guide for suggestions, not a requirement: every placement below keeps working
as a Key. Publish, `packageGet`, and suggested rewrites use it to point an owner
at a more secure type when one fits; where none fits, they say nothing.

From the production credential inventory scan of 2026-10-12 (1034 packages). The
rows count placeholder references; with the 213 variable definitions the scan
also records (not placements), they add up to its 881 references.

| Placement (references)                                                                | More secure type that fits                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Header (355)                                                                          | Key with a `header` inject, through a scoped client   |
| Query parameter (1)                                                                   | Key with a `query` inject                             |
| Basic auth with a literal username and a secret password (0)                          | Key with a `basic` inject                             |
| URL path, such as `/bot<token>/` (20)                                                 | `url`                                                 |
| A password or refresh token posted to get a session (13)                              | `login`, or OAuth when the provider is an integration |
| Signing key (2)                                                                       | `signing`                                             |
| Webhook verification secret (4)                                                       | None needed; Keys verify webhooks                     |
| Other body fields, mostly identifiers such as a chat id (19)                          | None needed                                           |
| Values the scan cannot follow to a request: objects, returns, arguments, arrays (254) | None needed                                           |

Counted separately: 17 `secretJwtSign` calls (`signing` fits them too), and 256
computed and 10 vault placeholders, whose name or placement is known only at run
time (none needed). When a new placement shows up that no type fits, it stays a
Key, and the revisit-if below applies only if someone wants it covered.

## Consequences

- One door, four primitives, no mapping tables. Owners who opt into the new
  types get placement owned by the credential, which keeps values out of request
  bodies and paths for those credentials.
- Nobody is broken: Key placeholders, by-name grants, and today's package
  authority keep working, and suggestions are optional.
- Through a scoped client, authority is uniform: the actor's Use plus
  `package:execute`. Key placeholders keep the package authority that
  [0021](./0021-publish-gated-package-composition.md) records.
- Interactive calls through a client can hit `credential_ambiguous` after a
  second matching credential is added; the error carries a ready-to-retry call.
  Enablements do not drift.
- Two lanes stay side by side on purpose: Key placeholders and scoped clients.
- Kent decides each user-visible change before it ships.

**Revisit-if** a placement appears that no resolver kind can express without
returning a value to code.

## Amendment 2026-10-12

Kent: manifest credential need `kind` becomes **optional**.

- **Omitted `kind`:** any fetch-capable credential for that provider qualifies
  (Key/secret such as a PAT, oauth, login). The `credential()` client picks the
  code path (inject header, OAuth refresh on 401, login exchange). Package code
  is identical for PAT vs OAuth.
- **Declare `kind` only when a specific shape is needed:** `signing` (`sign()`),
  `mcp` (`callTool()`), `url`, or a provider/feature that truly requires one
  kind (for example oauth for Google user data). A declared `kind` keeps today's
  narrowing, so published manifests keep working (non-breaking).
- **`provider`** still defaults to the key (unchanged). **`description`** stays
  required; it never affects matching. It explains to the user or agent why the
  package wants access when mapping or when a need is ambiguous or unbound.
- **Typical need:** `"github": { "description": "Read PRs to summarize them" }`.
- **Missing scopes** surface at call time via 401/403 `x-kody-credential-hint`.
  Declaring scopes is possible future work.
- **Naming direction:** `credentials` is the umbrella term everywhere (secrets
  and integrations are credential subtypes). UI/UX is designed separately and is
  not decided here.
