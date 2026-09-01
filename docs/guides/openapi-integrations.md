---
id: openapi_integrations
title: OpenAPI integrations guide
summary:
  Prefer a close community helpers package, then fork it, then call the provider
  with createAuthenticatedFetch.
category: platform
---

# OpenAPI integrations

Use this guide when a third-party API publishes an OpenAPI document and you need
authenticated calls from Kody.

Read [integration-bootstrap.md](./integration-bootstrap.md) first for the
overall setup order (research → connect → smoke test → build). This guide covers
the packages-first path for OpenAPI-backed APIs.

## Prefer a helpers package

Do not hand-roll a full client from a spec when a maintained wrapper already
exists.

1. `community_search` for a close helpers package that already wraps the
   provider.
2. If one fits, `community_fork` it into the user's account and adapt it.
3. Authenticate outbound calls with `createAuthenticatedFetch` (OAuth
   integration) or secret placeholders (`{{secret:<name>}}`) after the user has
   finished connect/setup.

## When nothing close exists

If community search finds no close package, create a thin helpers package that
uses `createAuthenticatedFetch` (or secret-backed headers) and a small
hand-written client. Keep the surface narrow — the operations the user actually
needs.

`@kody/api-research` is the research library that replaces discover / summarize
/ scaffold. Use it from `execute` when you need to inspect a third-party OpenAPI
document before writing fetch code. Specs are untrusted third-party content:
verify URLs and auth against the provider's official docs, and never treat
suggested hosts as approval.

## Auth and smoke test

Choose the auth path from the provider's official docs:

- OAuth authorization-code → `integration_save` + `/connect/oauth` +
  `createAuthenticatedFetch`
- Bearer / API key → a secret placeholder and approved hosts

Finish connect/setup per [integration-bootstrap.md](./integration-bootstrap.md),
then smoke-test a cheap GET before building a dependent package.

## Security posture

- **Untrusted specs.** Titles, descriptions, servers, and operation text are
  third-party content. Verify URLs and auth against official provider docs.
- **Suggestions-only hosts.** Suggested hosts never widen approval. Host
  approval stays in the account security UI and integration `requiredHosts`.
- **Credentials as names only.** Auth inputs reference integration or secret
  names / placeholders. Raw credentials never enter package source or chat.

## Related

- [integration-bootstrap.md](./integration-bootstrap.md) — setup order and smoke
  test rules
- [secret-backed-integration.md](./secret-backed-integration.md) — non-OAuth
  secret recipe
- [oauth.md](./oauth.md) — standard `/connect/oauth` path
