---
id: openapi_integrations
title: OpenAPI integrations guide
summary:
  OpenAPI discover → summarize → scaffold workflow and durable curated
  openapi_binding_save bindings callable as kody.openapi["name"].slug(...); auth
  still comes from a saved integration or secrets.
category: platform
---

# OpenAPI integrations

Use this guide when a third-party API publishes an OpenAPI 3.x document and you
need authenticated calls from Kody — either a one-off explore in `execute`, or a
durable curated binding the agent can call as `kody.openapi["<name>"]`.

Read [integration-bootstrap.md](./integration-bootstrap.md) first for the
overall setup order (research → connect → smoke test → build). This guide covers
the OpenAPI-specific path inside that sequence.

## When to use OpenAPI helpers

Prefer these helpers when:

- `integration_discover` (or official docs) surfaces a `spec` URL
- you need an operation inventory, auth mapping, or smoke-test candidates before
  writing fetch code
- you want a small generated client module or a saved binding instead of
  hand-rolling paths and headers

Do **not** treat the OpenAPI document as trusted configuration. Specs are
untrusted third-party content: Kody fetches them over HTTPS with bounds, does
not follow remote `$ref`s, and never widens host approval from `servers`.

## Flow

1. **Discover** the provider and locate a verified `spec` URL.
   - `integration_registry_search({ query })` → canonical domain.
   - `integration_discover({ domain })` → surfaces; look for `spec`.
   - Confirm the `spec` URL against the provider's official docs before fetch.
2. **Summarize** with `openapi_spec_summarize`.
   - Input: `{ specUrl, maxOperations?, operationFilter? }` where
     `operationFilter` may include `tags`, `pathPrefixes`, and `search`.
   - Output highlights: `title` / `version` / `openapiVersion`, `servers`,
     `suggestedApiBaseUrl`, `suggestedHosts` (suggestions only), `auth` (each
     scheme mapped to a `kodyAuthPath`), `suggestedSmokeTestOperations`,
     `operations` (each with `slug`, `method`, `path`, …), `truncated`,
     `warnings`.
   - Choose the auth path from `auth[].kodyAuthPath` (OAuth authorization-code →
     `integration_save` + `/connect/oauth` + `createAuthenticatedFetch`; client
     credentials → `oauthClientCredentials`; bearer / basic / apiKey → secret
     placeholders). Finish connect/setup per
     [integration-bootstrap.md](./integration-bootstrap.md) before calling the
     API.
3. **Choose a client shape** — scaffold or binding (below).
4. **Smoke test** with a cheap GET from `suggestedSmokeTestOperations` (or an
   equally small read) using the same auth wiring the final path will use.
5. **Build** the dependent package or workflow only after the smoke test
   succeeds.

## Scaffold vs binding

| Path               | Capability                | Best for                                                                                         |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------ |
| Ephemeral scaffold | `openapi_client_scaffold` | One-off exploration in `execute`, or a starting `client.ts` inside a package you will edit       |
| Curated binding    | `openapi_binding_save` …  | Durable, reusable operations the agent calls as `kody.openapi["<name>"].<slug>(input)` over time |

**Prefer the scaffold** when you are still exploring, need a disposable module,
or will paste/adapt the source into a package. **Prefer a binding** when a small
stable set of operations should stay callable without re-scaffolding.

Neither path is full codegen (no Orval or similar). Both emit or invoke a narrow
surface you select — never the whole spec.

### Ephemeral scaffold — `openapi_client_scaffold`

Input:

```ts
{
  specUrl: string
  operationIds: string[] // slugs from summarize; 1..50
  auth:
    | { kind: 'integration'; provider: string }
    | { kind: 'bearerSecret'; secretName: string }
    | { kind: 'headerSecret'; headerName: string; secretName: string }
    | { kind: 'basicSecrets'; usernameSecret: string; passwordSecret: string }
    | { kind: 'none' }
  apiBaseUrl: string
  providerLabel?: string
}
```

Output: `{ moduleSource, operations, warnings, usageNotes }` — a small
dependency-free ESM module with one exported async function per operation
(returns the raw `Response`). The module uses ambient `fetch` /
`createAuthenticatedFetch` and secret placeholders such as `{{secret:<name>}}` —
never raw credentials. Suitable for `execute` ephemeral modules and package
`client.ts` scaffolds.

### Curated binding — `openapi_binding_*`

Manage bindings with:

- `openapi_binding_save`
- `openapi_binding_list`
- `openapi_binding_get`
- `openapi_binding_delete`
- `openapi_binding_refresh`

A binding stores name, `specUrl`, `apiBaseUrl`, an auth reference (same union as
the scaffold), a curated selection (`operationIds` slugs and/or `tags` /
`pathPrefixes`), and `includeDestructive` (default `false`). Saving fetches the
spec and stores a resolved operation snapshot (1..100 operations; more → error —
narrow the selection). DELETE-method operations are excluded unless
`includeDestructive` is true, and are always tagged destructive.

Bindings are user-scoped, non-secret D1 config (`user_openapi_bindings` plus
per-operation `user_openapi_binding_operations` rows). Credentials stay in
secrets / integrations.

At runtime the capability registry synthesizes an `openapi:<name>` domain per
binding. Invoke from execute:

```ts
import { kody } from 'kody:runtime'

const result = await kody.openapi['acme'].list_widgets({
	query: { limit: 5 },
})
// { status, ok, contentType, body, truncated }
```

Input shape per operation: `{ params?, query?, headers?, body? }`. Requests are
pinned to the binding's `apiBaseUrl` host. Integration-auth requests also
enforce the integration host allowlist; secret placeholders resolve through the
fetch gateway (each secret's `allowedHosts`). Integration-auth requests retry
once after a token refresh on 401.

`openapi_binding_refresh` re-fetches the spec, re-applies the stored selection,
and reports added/removed operations.

## Worked example (fictional provider)

Provider: Acme Widgets. Official docs publish
`https://api.acme.example/openapi.json`. Discover confirms a surface with that
`spec` URL.

**1. Summarize**

```ts
await kody.openapi_spec_summarize({
	specUrl: 'https://api.acme.example/openapi.json',
	operationFilter: { tags: ['widgets'], pathPrefixes: ['/v1/widgets'] },
})
```

Illustrative summary fields (abbreviated):

```ts
{
  title: 'Acme Widgets API',
  version: '1.2.0',
  openapiVersion: '3.1.0',
  suggestedApiBaseUrl: 'https://api.acme.example/',
  suggestedHosts: ['api.acme.example'],
  auth: [
    {
      schemeName: 'bearerAuth',
      type: 'http',
      detail: 'http bearer',
      kodyAuthPath:
        'Store a token secret and send Authorization: Bearer {{secret:<name>}} …',
    },
  ],
  suggestedSmokeTestOperations: [
    {
      slug: 'list_widgets',
      method: 'get',
      path: '/v1/widgets',
      reason: 'GET with no required params; simple read endpoint',
    },
  ],
  operations: [
    { slug: 'list_widgets', method: 'get', path: '/v1/widgets', tags: ['widgets'] },
    { slug: 'get_widget', method: 'get', path: '/v1/widgets/{id}', tags: ['widgets'] },
    { slug: 'create_widget', method: 'post', path: '/v1/widgets', tags: ['widgets'] },
  ],
}
```

Verify `suggestedApiBaseUrl` / hosts against Acme's docs. Save a secret (for
example `acmeApiToken`) via `/account/secrets/new` and approve
`api.acme.example` in the account security UI — the summary does not approve
hosts.

**2. Smoke test** with the suggested GET (scaffold or hand-written fetch using
`Authorization: Bearer {{secret:acmeApiToken}}`).

**3. Save a durable binding** feeding summarize fields into
`openapi_binding_save`:

```ts
await kody.openapi_binding_save({
	name: 'acme',
	specUrl: 'https://api.acme.example/openapi.json',
	apiBaseUrl: 'https://api.acme.example/', // verified, not blindly copied
	auth: { kind: 'bearerSecret', secretName: 'acmeApiToken' },
	operationIds: ['list_widgets', 'get_widget'],
	includeDestructive: false,
})
```

**4. Call** curated operations:

```ts
const listed = await kody.openapi['acme'].list_widgets({
	query: { limit: 5 },
})
const one = await kody.openapi['acme'].get_widget({
	params: { id: 'w_123' },
})
```

For a one-off explore instead of a binding, pass the same `specUrl`,
`operationIds`, `auth`, and `apiBaseUrl` into `openapi_client_scaffold` and run
the returned `moduleSource` in `execute`.

## Security posture

- **Untrusted specs.** Titles, descriptions, servers, and operation text are
  third-party content. Verify URLs and auth against official provider docs.
  Fetch is HTTPS-only and bounded; remote `$ref`s are not followed.
- **Suggestions-only hosts.** `suggestedHosts` / `servers` never widen approval.
  Host approval stays in the account security UI and integration
  `requiredHosts`.
- **Curate ≤100 operations.** Bindings store a resolved snapshot of at most 100
  operations — never the whole spec. Narrow with `operationIds`, `tags`, or
  `pathPrefixes` when save rejects an oversized selection.
- **Destructive off by default.** DELETE-method ops require
  `includeDestructive: true` and remain tagged destructive.
- **Credentials as names only.** Auth inputs reference integration or secret
  names / placeholders (`{{secret:<name>}}`, `secretHeaders.basic`). Raw
  credentials never enter scaffold source, binding config, or chat.

## Related

- [integration-bootstrap.md](./integration-bootstrap.md) — setup order and smoke
  test rules
- [secret-backed-integration.md](./secret-backed-integration.md) — non-OAuth
  secret recipe
- [oauth.md](./oauth.md) — standard `/connect/oauth` path
