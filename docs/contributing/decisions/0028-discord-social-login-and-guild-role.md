# 0028: Discord social login and official guild role

- **Status:** accepted
- **Date:** 2026-08-20

## Context

People should be able to sign in to Kody with Discord and receive a member role
in the official Kody Discord. Social login already exists for GitHub, Google,
and X (`oauth_connections`, no persisted provider tokens). User-owned Discord
integrations (`/connect/oauth`) are a different OAuth subsystem for the
assistant. Discord Linked Roles and `guilds.join` would either add a second
OAuth or auto-join people to the server during login.

## Decision

Add Discord as a fourth social-login provider (`identify email` only). Official
guild membership is a best-effort operator-bot role write from the stored
Discord snowflake. Do not persist Discord login tokens, do not request
`guilds.join`, and do not reuse `/connect/oauth` Discord apps for sign-in.

## Consequences

Login works without bot secrets (local, preview, tests). Role assignment skips
when the user has not joined the guild yet; `/account` exposes the existing
invite plus a sync control. A later Linked Roles flow can complement this
without replacing social login. Revisit if Discord login needs assistant scopes
or if plan-named roles should follow Stripe.
