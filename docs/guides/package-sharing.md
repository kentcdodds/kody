---
id: package_sharing
title: Share a package and manage access
summary:
  Give a person or team Use, Contribute, or Manage on one package with a grant,
  invite someone who is not in your organization yet, and know what each side
  can run, read, and pay for. Fork instead when they should own a copy.
category: platform
audience: agents
---

# Share a package and manage access

Access in Kody belongs to an **organization**. Resources (packages, apps, jobs,
secrets, integrations, memory, email) live in one org, and a **grant** gives one
person or team a preset on one resource. To let someone use a package without
sharing a login, grant them **Use** on it.

> [!TIP] Prefer a
> [fork](/docs/package-lifecycle#fork-a-close-public-package-before-creating)
> when they should own and edit a copy. Grant access when they should run
> **your** live package.

## Presets

| Preset         | On a package                                                        |
| -------------- | ------------------------------------------------------------------- |
| **Use**        | Read the source and run it (`package:read`, `package:execute`)      |
| **Contribute** | Use, plus write (`package:write`)                                   |
| **Manage**     | Contribute, plus publish, delete, and manage access for the package |

Advanced grants take an explicit permission list instead of a preset. No preset
includes `billing:*` or revealing a secret.

## Grant access

Call `accessGrant` from a request bound to the org that owns the package. You
need manage access on the package.

```json
{
	"resource_type": "package",
	"resource_id": "<package id>",
	"subject_type": "user",
	"username": "jesse",
	"preset": "use"
}
```

`accessList` shows who holds what. `accessRevoke` removes one grant by
`grant_id`.

## Invite someone who has no access yet

`inviteCreate` with `kind: "grant"` sends the same grant to an email address or
username. The token is shown once, with a prompt for the invitee's agent:

```json
{
	"kind": "grant",
	"email": "jesse@example.com",
	"resource_type": "package",
	"resource_id": "<package id>",
	"preset": "use"
}
```

The invitee calls `inviteAccept` with the token. Nothing attaches before they
accept. Invites expire after 7 days; `inviteRevoke` cancels a pending one.

Use `kind: "membership"` to add someone to the whole **team** org instead (with
a role and optional teams). Members hold the org-level basics plus what they are
granted. Owners hold everything. Membership invites are refused on a personal
(signup) org; create a team org to invite people.

Personal orgs can still grant Use/Contribute/Manage on packages via
`accessGrant` / `inviteCreate` `kind: "grant"` and revoke with `accessRevoke`.
The web Grants page is aimed at team orgs; manage personal-org grants through
those capabilities.

## What a collaborator can do

Someone who holds a grant but is not a member is an **outside collaborator**.
They must connect with **your** org selected at consent. Then they can:

- Read and run the packages they hold Use on
- Run ad hoc code that imports those packages
- Search the shared catalog

They cannot see anything else in your org, reveal secret values, or change a
package unless the grant says so.

### Who pays when a Use collaborator runs your package

The org is the billing boundary, and a connection is billed to the org it is
bound to. Jesse connects with the **owning** org selected, so everything his
runs use is charged there:

| Meter                                                                | Charged to                     |
| -------------------------------------------------------------------- | ------------------------------ |
| Usage events, credits, org and per-user budgets, outbound fetch      | **Owning org** (the bound org) |
| Daily and weekly **execute** limits (unique execute workers per day) | **Owning org's** execute pool  |

Execute limits are one org-wide pool that grows with the org's paid seats. A
grant-only collaborator draws from the owning org's pool but is not a seat, so
granting someone Use does not change your seat count or grow your pool. Nothing
from these runs is charged to the collaborator's personal plan.

Example: Jesse has Use on `@acme/bot`. Connected as `@acme`, a run debits acme's
credits and budgets and counts against acme's execute pool. Jesse's own
personal-org limits are untouched. See
[Organizations](/docs/organizations#execute-limits-one-org-wide-pool) for how
the pool is sized.

### Secrets and integrations on a granted run

Every run acts as a person, and a credential resolves only when that person
holds Use on it. When Jesse runs **your** package in your org:

- Secret **values** and integration tokens come from **your** org
- Jesse never gets `secret:read` from a Use grant
- Each secret or integration the package reads needs Jesse's own `secret:use` or
  `integration:use` on it. A Use grant on the package does not include them;
  grant them on the credential
- The package rules then narrow that use: `package:execute` on the package, and
  each secret or integration must allow that package (host allowlist,
  `allowed_packages`, or self-authored rules for user secrets)
- The same applies to `{{secret:…}}` in Jesse's own ad hoc code

See [Secrets](/docs/secrets) for placeholders and allowlists.

### Triggers in a shared package

A package's jobs, subscriptions, and webhooks run only for people who turn them
on for themselves with `enablementEnable`, and each run acts as that person with
their live access. If Jesse turns on the nightly job in `@acme/bot`, it runs as
Jesse, with Jesse's grants, and pauses if he loses access. Usage still counts
against `@acme`. See
[Organizations](/docs/organizations#automation-runs-as-the-person-who-turned-it-on).

## Cross-org imports

A package imports only packages from its own org. A package in org A cannot
import a package from org B, even with a grant. To reuse another org's public
package,
[fork](/docs/package-lifecycle#fork-a-close-public-package-before-creating) it
into your own org and import the copy.

## Which call to use

- One person or team, already known: `accessGrant`
- Someone without access or an account yet: `inviteCreate` with `kind: "grant"`
- The whole org: `inviteCreate` with `kind: "membership"` or `orgMemberUpdate`
- Take access away: `accessRevoke` (a grant) or `orgMemberRemove` (a member)

Search these names first and open capability detail for the exact call shape.
