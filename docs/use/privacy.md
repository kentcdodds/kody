# Privacy

How Kody stores your data and what a deployment admin can see.

## What Kody stores per account

Each signed-in user gets a fully isolated assistant. Kody stores account profile
information (email and username), secrets, values, memories, packages and their
source, jobs, email inboxes and messages, chat threads, durable storage, remote
connector configuration, OAuth grants, and package invocation tokens. All of
this is scoped to your account and is not shared with other users.

## What a deployment admin can see

On shared deployments, operators can grant an admin role for account
administration. Admins see account metadata only: user id, username, email,
created and updated timestamps, and role assignments. The admin UI lists users
and roles; it does not expose user content.

## What an admin can never see

The admin role is not a data-access role. Admins cannot see:

- Secret values or secret metadata (names, scopes, allowlists)
- Package invocation tokens
- Values
- Memories
- Packages and their source
- Jobs
- Email inboxes and messages
- Chat threads
- Durable storage contents
- Remote connector configuration
- OAuth grants

None of this appears in any admin endpoint, page, or API payload — not even in
redacted or count form.

## Deployment operator access

Role-based access controls the application surface. Whoever operates the
deployment — holding the Cloudflare account, D1 database access, and
`SECRET_STORE_KEY` — sits outside any application-level control, exactly as
before admin roles existed. The admin role grants no infrastructure access, and
infrastructure access requires no admin role.
