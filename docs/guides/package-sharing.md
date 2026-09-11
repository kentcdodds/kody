---
id: package_sharing
title: Share a package with another person
summary:
  Invite another paid Kody account to use one of your packages. Guests can read
  source and invoke, cannot publish or write, and must accept before the package
  attaches. Pin or follow published commits after accept.
category: platform
audience: agents
---

# Share a package with another person

> [!TIP] Prefer a
> [fork](/docs/package-lifecycle#fork-a-close-public-package-before-creating)
> for most use cases. Share when someone should use **your** live package
> without getting their own copy.

<details>
<summary>What's the difference between forking and sharing?</summary>

**Fork** copies a public package into the other person's account. They own that
copy: they can edit, publish, schedule jobs, and keep their own storage. Use a
fork when they should adapt the behavior or run it independently.

**Share** leaves the package in your account. After the guest accepts, they can
read source and invoke it, but they cannot publish or write it. Storage stays
yours. Use a share when you want one live package — a household tool, a private
package that should not be public, or a source of truth that should stay in
sync.

Both people need a paid plan to share. Forking a public listing does not.

</details>

Use this guide when one person should **use** another person's package without
sharing a login. Sharing is behind the `package-share-grants` feature flag (off
by default). Search `packageShareInvite` / `packageShareAccept` first; open
capability detail for the exact call shape.

## What sharing is

Package sharing is an invitation from a package **owner** to a **guest**. The
guest keeps their own account. After they accept, they can import and invoke the
shared package and read its source.

Sharing is not:

- Giving someone your password or MCP token
- A community fork (the guest does not get their own copy of the source repo;
  prefer a
  [fork](/docs/package-lifecycle#fork-a-close-public-package-before-creating)
  when they should own a copy)
- A platform scope grant (`package_scope_grants`). Those are admin-minted,
  platform-account only, and grant full authoring under a platform scope. Person
  accounts never own that table.

## Invite, accept, use, leave

1. Owner invites by **username or email** (`packageShareInvite`). The invite
   email links to `@{owner}/{packageName}` with an Accept banner. Email invites
   bind to an existing account only when that mailbox is verified; otherwise the
   row stays pending until the guest verifies.
2. Guest **must accept** (`packageShareAccept`). Nothing attaches silently.
3. Invite-before-signup: a pending invite is held. The email explains Kody, what
   is shared, and that the guest creates an account, pays, then accepts.
4. Guest uses the shared package from their own packages or `execute`.
5. Owner **revokes** (`packageShareRevoke`) or guest **leaves**
   (`packageShareLeave`). New invokes fail immediately. An in-flight Worker
   isolate may finish.

Both owner and guest must be on a **paid** plan to invite, accept, and use.

## Pin and follow

At accept, the guest chooses a trust level. The Accept UI defaults to `pin`.

- `pin` — accept the current published commit only. If the owner publishes
  ahead, use and import fail closed with a link to
  `/@{owner}/{packageName}/approve-changes`. That page shows the accepted →
  current published source diff. Approve updates the snapshot only for the
  commit that was reviewed; a later owner publish requires a fresh review.
  Approve and follow switches trust to `follow`.
- `follow` — accept the current published commit and auto-accept later owner
  publishes.

`accepted_published_commit` and `trust_level` live on the grant. This pin is
**grant-level publish trust**, not a user-facing import specifier pin
([0001](../contributing/decisions/0001-no-package-versioning.md)).

## What a guest can and cannot do

The v1 role is `use`: `read_source` + `invoke`. Future `collaborate` / `write`
roles can add more permissions without changing the grant table.

Guests can:

- Read package source (safety review for human and agent)
- Invoke and import the shared package
- Create **their own** packages that depend on the granted package
- Use package-scoped secrets **through** the package

Guests cannot:

- Publish or write the shared package
- See raw secret values (hard invariant)
- Create jobs, apps, webhooks, or subscriptions on the shared package
- Watch the owner's transcripts or runs

Shared state is the owner's `packageStorage`. The owner pays that storage even
when a guest writes it. The guest pays executes and jobs on **their** packages.
The owner pays owner-created jobs and apps on the shared package.

## Runtime isolation

When shared package code runs for a guest, it does **not** receive the guest's
other user secrets, integrations, or packages by default. It gets package-scoped
powers (owner stamp, mounts, owner storage) plus **explicit inputs**. Guest
wrapper modules still run as the guest. Imported shared modules stay stamped as
the shared package.

## MCP playbook

Invite by scoped name:

```json
{
	"name": "@alice/household-notes",
	"username": "jesse"
}
```

Accept with the safer default (`pin` if `trust_level` is omitted):

```json
{
	"name": "@alice/household-notes",
	"trust_level": "pin"
}
```

List what you shared and what is shared with you:

```json
{ "scope": "outbound" }
```

```json
{ "scope": "inbound" }
```

Approve a pin-ahead publish, optionally switching to follow:

```json
{
	"grant_id": "…",
	"switch_to_follow": false
}
```

Use `packageShareInspect` for one grant, `packageShareRevoke` as the owner, and
`packageShareLeave` as the guest. Prefer scoped package `name` over leftover
`kody_id` in examples.

UI: package settings share controls, `/account/shared`, and the Accept / Approve
changes banners on `@{owner}/{packageName}`.
