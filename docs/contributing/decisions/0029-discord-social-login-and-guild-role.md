# 0029: Discord social login and official guild role

- **Status:** superseded by
  [0030](./0030-discord-guilds-join-on-social-login.md)
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
when the user has not joined the guild yet; `/discord` is the public join-and-
connect page, and `/account` still exposes the invite plus a sync control.
Standard and Pro guild roles follow `users.stripe_plan` (checkout, webhooks, and
plan-refresh alarms), not the effective manual+Stripe plan. A later Linked Roles
flow can complement this without replacing social login. Revisit if Discord
login needs assistant scopes.
