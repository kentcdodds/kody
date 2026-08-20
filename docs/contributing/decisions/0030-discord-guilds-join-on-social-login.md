# 0030: Join the official Discord during social login

- **Status:** accepted
- **Date:** 2026-08-20

## Context

[0029](./0029-discord-social-login-and-guild-role.md) added Discord social login
with `identify email` only. Guild membership stayed on a public invite; login
only wrote roles from the stored snowflake. `/discord` then had two CTAs (join
invite + connect). People expected **Connect Discord** to both link the account
and put them in the official server.

## Decision

Request `guilds.join` on Discord social login. On every successful Discord
callback, best-effort **Add Guild Member** with the operator bot plus the
ephemeral user access token, then discard the token. Still do not persist
provider tokens, and still do not reuse `/connect/oauth` Discord apps for
sign-in.

## Consequences

The bot needs **Create Instant Invite** in addition to **Manage Roles**. Join
failures are logged and never fail login; mock OAuth has no user token so join
skips. `/discord` is one **Connect Discord** action. Revisit if Discord login
needs assistant scopes, or if join must become a hard login failure.
