---
id: api_versioning
title: API versioning and deprecation
summary:
  How Kody versions the HTTP Open API under /v1, signals deprecations, and
  migrates without breaking people and their packages.
category: platform
---

# API versioning and deprecation

Kody’s public HTTP API is versioned under `/v1` at
[api.kody.codes](https://api.kody.codes). The OpenAPI document is at
[/openapi.json](https://api.kody.codes/openapi.json); interactive docs are at
[api-docs.kody.codes](https://api-docs.kody.codes).

## Principle

We do not break people and their packages. Changes within `/v1` are additive
whenever possible: new operations, optional fields, and new error codes that
existing clients can ignore.

## When something must change

If a breaking change is unavoidable, we use a phased migration:

1. **Ship a codemod** when the change can be applied automatically to packages
   and configs, so most users never have to do the migration by hand.
2. **If a codemod is not possible**, announce early (docs, Discord, and email
   when impact warrants it) with prompts users can hand their agents, plus
   manual steps when needed.
3. **Keep the old path working** for a deprecation window proportional to how
   long the surface has existed, how complicated the migration is, and how
   impactful the change is.
4. **Only then** remove or fail the old shape, after the window and after
   leftover cleanup of dual-writes and shims.

## How deprecation is signaled

When an operation, field, or path is deprecated:

- The OpenAPI document marks it deprecated and describes the replacement.
- HTTP responses may include `Deprecation` and `Sunset` headers once something
  is actually deprecated (we do not send those headers preemptively).
- Docs and [`/llms.txt`](/llms.txt) point at the replacement guide.

## Rate limits

Edge rate limits on `api.kody.codes` return HTTP `429` with `Retry-After`
(seconds) and a `RateLimit-Policy` advertisement. Entitlement and plan-cap
limits also use `429` with the same error envelope and a `Retry-After` hint.
Prefer backing off for at least that many seconds before retrying.

## Related

- [Open API](./open-api.md) — minting tokens and calling operations
- Engineering principle:
  [No breaking changes](../principles/no-breaking-changes.md)
