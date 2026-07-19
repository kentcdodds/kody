# Privacy

How Kody stores your data and what a deployment admin can see.

## What Kody stores per account

Each signed-in user gets a fully isolated assistant. Kody stores account profile
information (email and username), secrets, values, memories, packages and their
source, jobs, email inboxes and messages, chat threads, durable storage, remote
connector configuration, OAuth grants, package invocation tokens, and any
platform feedback you approve for submission. All of this remains scoped to your
account except for the narrow admin review of approved platform feedback
described below.

## What a deployment admin can see

On shared deployments, operators can grant an admin role for account
administration. Admins see account metadata: user id, username, email, created
and updated timestamps, and role assignments. The account-administration UI
lists users and roles; it does not expose account content.

Platform feedback you explicitly approve for admin review is a narrow
user-content exception.

Admins also moderate public community listings and attributed community reports.
That review covers content deliberately published or reported through community
features, not private package source or unrelated account content.

## Platform feedback

When an agent encounters meaningful Kody friction, a Kody bug, a poor
experience, or a suggestion, it may briefly explain the issue and ask whether
you want it submitted. The agent submits nothing unless you explicitly approve.
Normal third-party or authentication failures do not automatically become
platform feedback, though you can ask to submit any Kody-related issue.

Feedback is attributed to your authenticated account and is not anonymous. Admin
list results intentionally omit the full submission. An admin can open the
approved submission to read and triage it, but that does not grant access to
your packages, memories, email, secrets, or other account content. Agents must
omit secrets and unrelated private content from the feedback they prepare.

Each account can create at most 10 feedback submissions in a rolling 24-hour
period and have at most 100 active submissions (open or triaged). Open and
triaged feedback remains until it is resolved, dismissed, or your account is
deleted. Resolved and dismissed feedback is removed 365 days after its last
update. Account deletion removes any remaining submissions.

Your account export includes your own submissions and their status. Internal
reviewer identity, notes, and timestamps are not included. If an admin who
reviewed your feedback deletes their account, Kody clears that reviewer's
attribution while retaining your submission for the lifecycle described above.

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
- Chat threads
- Durable storage contents
- Remote connector configuration
- OAuth grants

None of these stores appears in an admin endpoint, page, or API payload — not
even in redacted or count form.

## Deployment operator access

Role-based access controls the application surface. Whoever operates the
deployment — holding the Cloudflare account, D1 database access, and
`SECRET_STORE_KEY` — sits outside any application-level control, exactly as
before admin roles existed. The admin role grants no infrastructure access, and
infrastructure access requires no admin role.
