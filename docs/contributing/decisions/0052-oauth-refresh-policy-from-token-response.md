# 0052: OAuth refresh expectation comes from the token response (no app refresh defaults, no blanket Waiting suppression)

- **Status:** accepted
- **Date:** 2026-09-30

## Context

GitHub OAuth Apps with token expiration off issue long-lived access tokens and
no refresh token. `refreshIntegrationTokens` treated every missing refresh token
as broken, persisted `missing_refresh_token`, and Waiting asked the user to
reconnect healthy connections (`integration-auth:github-kent`,
`integration-auth:github-bot`). Three fixes were on the table: infer whether
refresh is expected from each connect's token response, add app- or
adapter-level `refresh: always | when_issued | never` defaults, or never show
Waiting for `missing_refresh_token`.

## Decision

Only the first. Each `/connect/oauth` token persist writes
`user_integrations.refresh_policy`: `required` when the response carries a
refresh token or an access-token expiry (`expires_in` / `expires_at`), otherwise
`not_applicable`. A reconnect overwrites it. `not_applicable` connections skip
refresh (`refreshed: false`) and never surface `missing_refresh_token`.
`required` connections without a refresh token still wait. Code:
`packages/worker/src/integrations/refresh-policy.ts`.

We do **not** add refresh defaults on OAuth apps, platform apps, or provider
adapters, and we do **not** suppress `missing_refresh_token` Waiting across the
board.

## Consequences

- One product rule: wait on a missing refresh token only when refresh is
  expected. The provider says so at connect; Kody does not guess per provider.
- A lost refresh token on an expiring grant still reaches Waiting.
- Existing rows were backfilled from stored metadata (stored refresh token or a
  past successful refresh means `required`). A pre-policy connection that
  expires but never stored a refresh token or refreshed reads as
  `not_applicable` until it is reconnected.
- Revisit if a provider issues expiring tokens without advertising expiry in the
  token response, so the inference cannot see that refresh is expected.
