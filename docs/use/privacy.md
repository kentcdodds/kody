# Privacy

How Kody stores your data, how connected accounts work, and what a deployment
admin can see.

## What Kody stores per account

Each signed-in user gets a fully isolated assistant. Kody stores account profile
information (email, username, optional display name and bio, and profile
visibility), secrets, values, memories, packages and their source, jobs, email
inboxes and messages, durable storage, MCP server configuration, OAuth grants,
package invocation tokens, short-lived execution history (see
[Activity](./activity.md)), community social graph edges (follows, listing
stars, and stored activity events), and any platform feedback you approve for
submission. All of this remains scoped to your account except for content you
deliberately make public (community listings and a public profile), the narrow
admin review of approved platform feedback, and the community activity metadata
described below.

When profile visibility is **public**, display name, bio, public package
metadata, follow counts, and public activity are visible on `/@username` and
related social surfaces. When visibility is **private**, the public profile is
not found, others cannot follow you, and you are omitted from stargazer lists
and other users' timelines. See [Community profiles](./community-profiles.md).

Account export includes your profile columns and social rows where you are a
participant (follows as follower or followee, stars you placed, and activity you
authored). The browser download is a bounded metadata manifest; use its
`account_export_section` instructions to retrieve every D1, Durable Object, and
R2 page for a complete portable export. Account settings can delete the account
after you type `GOODBYE KODY` in a confirmation modal (and re-enter your
password when the account has one). Account deletion removes those same
user-owned rows and objects.

## Connected accounts

When you connect a third-party service — a built-in integration Kody hosts, or
an OAuth app or API key you register yourself — Kody stores that connection in
your account only: tokens, the scopes you granted, and host allowlists. Those
credentials stay in the encrypted secret store. Your agent and package code
refer to them by name; Kody substitutes them at the network boundary and never
returns the raw value to chat, search, or capability output.

Kody fetches data from a connected service only to fulfill a request you, or a
job you saved, just made. Content a package or job persists (for example a saved
summary) stays in your account under the same isolation rules. Kody does not
sell that data, use it for advertising, share it with other Kody users, or use
it to train a Kody model. Kody makes no inference calls of its own.

**Share, transfer, and disclose.** Provider data leaves your isolated account
only to Cloudflare, which hosts the application, database, object storage, and
network; the MCP host you connected (for example ChatGPT, Claude, or Cursor),
when that host asks Kody to act and receives the result; the provider itself,
when Kody calls its API with your token; and disclosure required by law. Kody
does not hand connected-account data to other customers or advertisers.

**Protection.** Tokens and OAuth grants are encrypted at rest, isolated per
user, and sent only to hosts you approved. The admin role cannot read secret
values, secret metadata, or OAuth grants. You can disconnect a connection in
Kody and revoke it at the provider.

### Google user data

When you connect Google, the rules above apply to Google user data — Calendar,
Docs, Sheets, Gmail send, Contacts, Tasks, YouTube, and any other Google scopes
you grant. Kody uses Google user data only to fulfill your request or saved job.
Kody stores Google OAuth tokens in your encrypted secret store and does not use
Google user data for advertising. Kody shares, transfers, or discloses Google
user data only with Cloudflare (hosting), the MCP host you connected when it
asks Kody to act, Google when Kody calls Google APIs on your behalf, and when
required by law.

## What a deployment admin can see

On shared deployments, operators can grant an admin role for account
administration. Admins see account metadata: user id, username, email, created
and updated timestamps, and role assignments. The account-administration UI
lists users and roles; it does not expose account content.

Platform feedback you explicitly approve for admin review is a narrow
user-content exception.

Admins also moderate public community listings and attributed community reports,
and can see who forked or rated a public listing, when, and the rating scores.
One-click installs appear as forks because both use the same activity record.
This activity view never includes private package source, rating notes, email,
stable user ids, private profiles, secrets, or unrelated account content.
Admin-configured notification packages may receive the same community metadata,
and a metadata-only `user.created` or `user.deleted` event when a person account
is created or self-deleted (stable user id, username, email, and the create
source or delete timestamp). Those lifecycle events omit passwords, roles, plan,
secrets, and unrelated account content.

## Platform feedback

When an agent encounters meaningful Kody friction, a Kody bug, a poor
experience, or a suggestion, it may briefly explain the issue and ask whether
you want it submitted. The agent submits nothing unless you explicitly approve.
Normal third-party or authentication failures do not automatically become
platform feedback, though you can ask to submit any Kody-related issue.

Feedback is attributed to your authenticated account and is not anonymous. Admin
list results intentionally omit the full submission. Once you approve, the exact
approved summary and details and your account user id, username, and email may
be delivered immediately to admin review tools and admin-configured
notifications such as Discord. No unrelated account content is delivered.
Notifications can deep-link an admin to the read-only platform-feedback review
surface. An admin can open the approved submission to read and triage it, but
that does not grant access to your packages, memories, email, secrets, or other
account content. Agents must omit secrets and unrelated private content from the
feedback they prepare.

Each account can create at most 10 feedback submissions in a rolling 24-hour
period and have at most 100 active submissions (open or triaged). Open and
triaged feedback remains until it is resolved, dismissed, or your account is
deleted. Resolved and dismissed feedback is removed 365 days after its last
update. Account deletion removes any remaining submissions.

When a notification is still queued, Kody rechecks that the feedback exists
immediately before delivery and cancels it after account deletion when possible.
Kody cannot recall a notification copy that was already delivered outside Kody.
Admin notification copies, including Discord messages, may remain after Kody
account deletion under the deployment operator's retention and deletion
controls. Those copies contain only the exact approved feedback and its
attribution described above, never unrelated account content.

Your account export includes your own submissions and their status. Internal
reviewer identity, notes, and timestamps are not included. If an admin who
reviewed your feedback deletes their account, Kody clears that reviewer's
attribution while retaining your submission for the lifecycle described above.

Community stars, stored activity events, ratings, forks, and reports appear only
in the participating user's account export. Owning the related listing does not
expose another user's event timestamps or types, identity, rating or adoption
notes, report reasons, or moderation details.

## What an admin can never see

The admin role is not a general data-access role. Approving platform feedback
does not let admins browse:

- Secret values or secret metadata (names, scopes, allowlists)
- Package invocation tokens
- Values
- Memories
- Private packages and their source
- Jobs
- Email inboxes and messages
- Inbound webhook endpoints and delivery logs
- Durable storage contents
- Connected MCP server configuration and OAuth grants

None of these stores appears in an admin endpoint, page, or API payload — not
even in redacted or count form — with one qualified exception: platform
maintenance codemods, described next, surface package identity, affected file
paths, and fixed migration messages (never file contents).

## Platform maintenance (package codemods)

When the platform's package API changes, Kody migrates published package source
with **package codemods**: versioned, deterministic transforms that live in the
open-source repository and ship through code review like any other platform
change. Nobody can author an ad hoc transform through the admin surface — admins
only choose when a published, reviewed codemod runs, and can scope it to a dry
run first.

A codemod apply rewrites only what the reviewed transform matches, republishes
the package through the same checks as a normal publish, records a
`codemod(<id>): ...` commit in the package's own git history, keeps a revert
snapshot, and dispatches a `package.codemod.applied` (or `.reverted`) event your
packages can subscribe to. Fleet runs are audit-logged.

Running a codemod never shows an admin your source. Scan and run results expose
only package identity (ids), affected file paths, and the codemod's own fixed
finding messages — codemods are forbidden from embedding file contents in their
findings. Ambiguous matches are skipped and reported for the owner rather than
rewritten.

## Deployment operator access

Role-based access controls the application surface. Whoever operates the
deployment — holding the Cloudflare account, D1 database access, and
`SECRET_STORE_KEY` — sits outside any application-level control. The admin role
grants no infrastructure access, and infrastructure access requires no admin
role.
