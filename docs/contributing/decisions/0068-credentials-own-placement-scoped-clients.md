# 0068: Credentials own placement; scoped clients replace slots, assignments, and placeholders

- **Status:** accepted
- **Date:** 2026-10-11
- **Supersedes in part:** [0021](./0021-publish-gated-package-composition.md)
  (package attachments, slot bindings, and attested package stamps as credential
  authority), [0042](./0042-no-capability-input-secrets.md) (package grants and
  `x-kody-secret-resolution` staying), and credentials plan v4 section 3.3
  (assignments) and section 3.4 (placeholder grammar). The v4 plan lives outside
  this repo.

This record is the source of truth for the credentials model. Credentials plan
v4 still holds for personal credentials (3.2), enablements, the one
`resolveCredential` door, audit, and leak tests, except where this record
changes them. Until the migration below reaches T, runtime behavior follows the
records it supersedes.

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
own their hosts and placement, and a scoped client that is the only surface code
touches.

Baseline: [#3210](https://github.com/kentcdodds/kody/pull/3210) (`77a82ed3`)
requires the actor's Use on CLI local execute even when a package id is stamped,
and [#3169](https://github.com/kentcdodds/kody/pull/3169) (`0d140d22`) enforces
per-resource Use when resolving org credentials. This record builds on both.

## Decision

In short:

- A credential owns its hosts and how its value is placed (header, basic, or
  query; never the body). Code never decides where a value goes.
- Code reaches a credential only through a scoped `credential(key)` client.
  Placeholders, slots as grants, assignments, saved bindings, and package
  allowlists go away.
- The actor's Use plus `package:execute` is the only authority. Package stamps
  grant nothing.
- Callers pick among candidates with a call map; triggers store the pick in an
  enablement. Zero or several candidates is a structured error, never a default.
- The old lane is removed right after the fleet codemod if a rescan finds no old
  patterns, otherwise when the rest convert, or at T+90 at the latest.

The sections below are the full specification.

### Primitives

There are four:

1. **Credential.** An org-owned or user-owned secret, OAuth connection, or MCP
   server. It owns its hosts and how its value is placed in a request.
2. **Resolver.** One per credential kind, all behind the one `resolveCredential`
   door.
3. **Scoped client.** The only credential surface package or user code touches.
4. **Enablement.** The only persisted credential choice, used for triggers
   (cron, subscription, webhook) that have no live caller.

Mapping or assignment tables, saved bindings, package allowlists and usage
modes, and placeholders all go away (see [Migration](#migration)).

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
  produces or verifies a signature.
- `audit(outcome)` writes one row per resolution, including denials: person,
  oauthClientId, package, need key, credential id, and outcome. Never a value.

Kinds: `secret`, `oauth`, and `mcp` (the `mcp` client exposes `callTool`, not
`fetch`). Later kinds are new resolvers in the same door, not new lanes:

- `login`: the gateway runs the login exchange and injects only the session
  token; the login response never reaches code.
- `url`: a whole-URL secret pinned to its own host, over HTTPS.
- `signing`: signs or verifies requests. Webhook signature verification moves
  here.

### Credential fields

```
{ id, ownerKind: 'org'|'user', kind, provider: slug|null, name, hosts[], inject, source: 'stored'|{ vault, ref } }
```

`inject` never places a value in the body. It is one of:

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
manually and authorized again on every hop.

Personal credentials follow plan v4 3.2: user-owned, granted to orgs one org at
a time, never usable by Owners or Automation on someone else's behalf. A
personal OAuth credential minted through an org's OAuth app is pinned to that
org.

### Use grants (`accessGrant` / `accessRevoke`)

`accessGrant` and `accessRevoke` keep accepting secret and integration names and
resolve each name to a credential id at grant time. Granting and revoking by
credential id is added alongside. By-name grants belong to the old lane and are
removed with placeholders at old-lane removal.

### Manifest (`kody.credentials`)

The keyed map stays. `provider` is optional and defaults to the key.

```json
"credentials": {
  "github":     { "kind": "oauth", "description": "Repos to triage" },
  "github_bot": { "kind": "oauth", "provider": "github", "description": "Bot account" },
  "google":     { "kind": "oauth", "multiple": true, "description": "Calendars" }
}
```

- Publish warns (does not fail) when a key is not a provider slug
  (`^[a-z0-9-]+$`).
- A second account from the same provider gets its own key with an explicit
  `provider`. There is no `as` field.
- There is no hosts, inject, or placement field.
- **Needs closure:** the package's needs plus those of its snapshotted
  dependencies (pinned at the dependent's publish, per
  [0001](./0001-no-package-versioning.md)), computed at publish and stored with
  the bundle. A key that conflicts on kind or provider is a publish error.
- `packageGet` tags needs inherited from a dependency with `from`.

### Code API (`kody:runtime`)

- `credential(key)` returns `{ fetch, callTool?, sign?, name, scope }`. A
  relative URL resolves against the credential's first host; an absolute URL
  must be in `hosts`. If code sets the header the credential injects, the
  gateway overwrites it.
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

1. **Candidates:** credentials with the need's kind and provider that the actor
   can Use in the run org (org credentials with Use, plus the actor's own
   personal credentials granted to that org). A null provider never
   auto-resolves.
2. **Map entry:** an exact pick. Kind must match; provider must match when both
   sides have one.
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

Every option and match is filtered by the actor's Use. From T, `packageGet` also
warns about remaining legacy patterns.

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
  warns when the package has live enablements. Webhook verification goes through
  the door with the enablement as the actor, retiring the no-actor exception.
- **Inbound email:** a member sender is the actor. Mail from a non-member runs
  the inbox owner's enablements.

### Identity and MCP tokens

- Nothing resolves without a `PersonId` actor with a live org binding.
- New OAuth grants require `personId`, stamped at consent the same way
  [0064](./0064-oauth-org-binding.md) stamps `orgId`.
- Legacy grants in a personal org derive the person after a database check (the
  org is personal and that person is its only member). In a team org, a grant
  with no person must re-consent and fails closed until then.
- At P9 the props fallbacks (`orgId ?? userId` and the person fallback) are
  dropped.

### Security properties

- No credential value enters package or user code, logs, errors, or tool output,
  and code never decides where a value goes. Placement belongs to the credential
  and is never the body.
- Publishing, republishing, or forking cannot widen a credential's hosts or
  placement.
- The actor's Use is the only grant; CLI `--local` stays closed.
- Personal credentials work only in their owner's runs, in orgs the owner
  granted them to.
- Option lists never reveal credentials the actor cannot use.
- Echo redaction stays as defense in depth.
- Remaining risk: a token can do whatever it allows on its allowed hosts. Keep
  OAuth scopes minimal and visible.

### Lifecycle

- **Org access ends:** that org's personal grant row is hard-deleted and
  affected enablements pause. OAuth credentials pinned to that org are wiped and
  revoked upstream.
- **Owner deletes a credential:** the value is tombstoned immediately, with no
  restore.
- **Account deleted:** every value is tombstoned at soft delete and never
  restored; rows are purged per [0066](./0066-soft-delete-and-purge.md).
- **Account suspended:** resolution is denied and nothing is wiped.

### Migration

T is the date clients and call maps are live in production.

**Interim rule (Kent, 2026-10-11):** do not break anyone. Until clients are live
and packages have migrated, production keeps filling placeholders anywhere on
allowed hosts over HTTPS. There is no interim switch to header-only.

**Gate on T.** T is not declared until every placement the scan finds in stored
package source has a working target: headers use `credential()`, query
placements use `query{ param }`, body placements use `login` (or `signing` where
the scan finds a signature), and path or whole-URL placements use `url`. Ad hoc
usage and computed patterns the scan cannot classify get warnings and do not
hold up T.

**P1 (before T, no visible change):** add `provider`, `inject`, and `source`
columns. Backfill `provider` from OAuth apps and from the slots that reference
each secret. Backfill `inject` from consistent usage in stored package source,
defaulting to Bearer when usage is inconsistent or absent. Ship personal
credentials and org grants (v4 3.2) as backend only: schema, service, and
resolver candidates, with no public capability or UI until T. Stamp `personId`
on new OAuth grants.

**T:** ship the client API, call maps (invoke, execute, CLI, enable),
`packageGet` needs, the stored needs closure, and enablement snapshots, then run
the fleet codemod. It rewrites a call site only when the result behaves
identically:

- Rewritten: a placeholder in a literal header in the `init` object that matches
  the credential's backfilled `inject`, where the credential's hosts cover the
  URL (URLs stay absolute); integration-token placeholders only when the header
  is exactly `Authorization: Bearer`; query placeholders only when the backfill
  found one consistent param; secret basic auth with a literal username and a
  secret password, to `basic{ valueAs: 'password', other }`.
- Never rewritten (warning only): dynamically built headers; a credential used
  with two header shapes; placeholders in the body or path; basic auth where
  both parts are secret; calls that set `x-kody-secret-resolution: off` or
  `headers-only`; vault placeholders (the codemod creates no credentials).
- Declared keys named after a secret (for example `RESEND_API_KEY`) are renamed
  to their provider when that provider is unique in the package.
- Each package gets one revertable commit. A package is republished only when it
  is clean, has no drift, and passes its checks; otherwise the change waits as a
  proposal in the owner's waiting-for-me list. Locked, drifted, and unpublished
  packages get warnings and email.

Package-scoped values each become an org credential named
`<package-leaf>-<name>` (suffixed if taken; the email says so). The codemod adds
a manifest need if missing and sets the credential's provider to that need's
provider so it auto-resolves; `hosts` and `inject` come from the backfill. Use
goes to whoever wrote the value, and in team orgs also to members who ran the
package in the last 90 days; the owner email lists those grants and notes they
work anywhere in the org. `|scope=user` becomes a plain reference;
`|scope=session` is deleted.

**Old lane removal (Kent, 2026-10-11):** right after the codemod runs at T,
rescan every package. The rescan counts every placeholder reference, including
ones that match a declared key (the codemod 0010 detector skips those, so its
clean result is not enough). If no old patterns remain, remove the old lane at
once: publish rejects placeholders, `secretMounts`, `packageSecrets`, `|scope=`,
and webhook `secretName` (which becomes a need key); the gateway stops parsing
placeholders; and the `x-kody-secret-resolution` header, package allowlists,
usage modes, provider grants, by-name `accessGrant` / `accessRevoke`, lock
capabilities, the attested and claimed authority split (stamps remain for
storage only), and the webhook no-actor exception are deleted. Only packages the
codemod could not convert get a window, with warnings in publish responses and
`packageGet` and email at T and T+60. The lane is removed as soon as a rescan
shows them gone, or at T+90 at the latest. Two lanes never stay behind.

**P9:** drop the grant-props fallbacks.

## Consequences

- One door, four primitives, no mapping tables. Placement moves from code to the
  credential, which closes body and path placement for every package at T.
- Authority is uniform: the actor's Use plus `package:execute`. Package runs
  lose the package-attachment grant that
  [0021](./0021-publish-gated-package-composition.md) records, so a runner needs
  Use on each credential a run touches.
- Interactive calls can hit `credential_ambiguous` after a second matching
  credential is added; the error carries a ready-to-retry call. Enablements do
  not drift.
- The `login`, `url`, and `signing` kinds must ship before T can be declared.
- Kent decides each user-visible step (new refusals, publish failures, owner
  emails, removing the old lane) before it ships.

**Revisit-if** a placement appears that no resolver kind can express without
returning a value to code.
