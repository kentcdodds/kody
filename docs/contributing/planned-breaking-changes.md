# Planned breaking changes

Leftover fields and params that still work, and that a later change will remove.
This is not a changelog and not a soak runbook. Architecture docs and code
describe current behavior; this list is the tracker so agents do not treat these
leftovers as identity.

When an item is safe to drop, follow
[cleanup after migrations](./cleanup-after-migrations.md): remove it in the same
change, or open a `Cleanup:` issue if a gate remains.

## `kody_id` / `kody.id`

Package identity is `package.json` `name` (`@scope/leaf`) **or** the
saved-package UUID `package_id` — one or the other, never both required. Prefer
the scoped name when you know it. Use `package_id` only when the name is not
known, or for a stable ref. The leaf after `/` is the URL slug.

`kody_id` (MCP / DB / URLs) and authored `package.json#kody.id` still work.
Create and resolve accept a leaf or a matching `@scope/leaf`. They are leftover
identity names. A future breaking change will remove the authored field, the
public MCP param, and (separately) rename the `saved_packages.kody_id` column.

Prefer the scoped `name` in docs, capability blurbs, and new callers. Mention
`package_id` only as the fallback. Do not teach `kody_id` / `kody.id` as
first-class identity.

Server lookups go through `resolveSavedPackageRef` (leaf, `@scope/leaf`, or
UUID; slug = leaf of `saved_packages.name`). The `saved_packages.kody_id` and
`community_listings.kody_id` columns are still written but are not lookup keys.
Rename redirects dual-write `package_slug_redirects` and the legacy
`package_kody_id_redirects`. Dropping the columns and the legacy table is
[#1909](https://github.com/kentcdodds/kody/issues/1909) phase 4.

**Ready when:** agent transcripts and create/resolve traffic no longer need the
leftover param (Sentry KODY-7M and similar scoped-name-as-`kody_id` collisions
stay quiet), and a dedicated removal PR can drop the field without a fleet
codemod.

**Introduced as leftover by:** the change that documents identity as scoped
`name` or `package_id` while leaving the leftover param in the runtime contract.

## Name-based credential resolution in packages that declare slots

A package that declares `kody.credentials` still resolves each reference by
name: `{{secret:NAME}}` reads the secret stored as `NAME`, through the same
package access rules as an undeclared package. Slots only drive publish
validation
([credential slots](../use/packages.md#credential-slots-kodycredentials)).

[ADR 0068](./decisions/0068-credentials-own-placement-scoped-clients.md)
replaces this name lane, and supersedes the assignments of credentials plan v4
section 3.3 and its placeholder grammar in section 3.4: there are no
assignments. Each credential owns its hosts and placement, package code reaches
it through a scoped `credential(key)` client, and callers pick among candidates
with a call map (or an enablement for triggers). A fleet codemod rewrites
placeholders it can convert identically. The placeholder lane, `secretMounts`,
`packageSecrets`, `|scope=`, webhook `secretName`, `x-kody-secret-resolution`,
and package allowlists and usage modes are then removed, at once if a rescan
finds no old patterns, otherwise when the remaining packages convert or at T+90
at the latest.

**Ready when:** the credential clients and call maps are live in production (T),
every placement the scan finds has a working resolver kind, and the post-codemod
rescan shows no old patterns (or T+90 for packages that could not be converted).

**Introduced as leftover by:** the `kody.credentials` manifest field (credential
slots ship before credential clients).

## By-name `secret` / `integration` grant targets

`accessGrant` and grant invites accept `secret` and `integration` targets by
name. The name resolves to a credential id at grant time; the grant is stored
under `credential`. A name that matches no credential is refused. `accessList`
accepts the same by-name filters and resolves the name when listing: after a
rename, the old name finds no grants, though the grant on the credential id
remains.

Grant by credential id is the durable path
([authorization](./architecture/authorization.md)). By-name targets go away with
secret placeholders when the leftover credential lane is removed
([ADR 0068](./decisions/0068-credentials-own-placement-scoped-clients.md)).

**Ready when:** callers grant by credential id, and the leftover credential lane
removal in ADR 0068 is ready.

**Introduced as leftover by:** stable credential ids (`#3442`) while name
targets remain accepted.

## Webhooks without a `verification` declaration

A webhook that declares no `verification` is treated as
`verification: { type: 'url-secret' }`, which stays a supported type for senders
that cannot sign
([inbound webhooks](../use/webhooks.md#senders-that-cannot-sign-url-secret)).
Codemod `0012-explicit-webhook-url-secret-verification` adds the explicit
declaration to existing packages. Then publish requires `verification` on every
webhook, and the implicit default goes away
([#3477](https://github.com/kentcdodds/kody/issues/3477)). No deliveries are
refused by this change.

**Ready when:** `adminWebhookVerificationScan` reports zero
`implicit_url_secret` webhooks after codemod 0012 is applied.

**Introduced as leftover by:** restoring URL-secret-only auth (`#3463`) and the
explicit `url-secret` type.
