# Search

The **search** tool finds **built-in capabilities**, **saved packages**,
**persisted values**, **saved integrations**, and **user secret references**
(metadata only, not secret values).

**Community package listings** are not included. Use the `community` domain
(`community_search`, `community_get`) or the public `/community` pages. See
[Community packages](./community-packages.md).

**Hidden saved packages** are excluded from ranked **query** results by default.
Pass **`includeHiddenPackages: true`** to include them. Hiding is not deletion:
known-id **`entity`** lookups (for example `my-package:package`),
**`package_list`**, and **`package_get`** still work. Use **`package_update`**
with **`changes: { hidden: true }`** to hide a package (or `false` to unhide
it). See [Packages](./packages.md#hidden-packages).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters. Query responses are intentionally
compact: the markdown response is a short list of matches with the result type,
title, one-line summary, and entity reference when applicable.

An entire saved-package UUID or `kody.id` is treated as an exact package
identity when it resolves for the signed-in user. Kody also recognizes
current-origin `/account/packages/:packageId` URLs and owner-matching
`/@username/packages/:kodyId` URLs. Exact package identities never compete with
semantic capability results. Hidden exact query matches still require
`includeHiddenPackages: true`; exact `entity` lookup by UUID or `kody.id`
ignores the hidden discovery preference.

When a tool call also includes **`memoryContext`**, Kody may include relevant
long-term memory metadata in structured content, but broad query markdown stays
focused on the ranked matches.

Search responses also return top-level **`timing`** metadata with
**`startedAt`**, **`endedAt`**, and **`durationMs`** so hosts can reason about
how long the ranked lookup or entity lookup took.

Optional **`limit`** caps how many ranked hits return. Optional
**`maxResponseSize`** trims low-ranked matches against the compact list when the
response must stay small.

## Single-entity detail

To get **full markdown and call shapes for one hit** (for example a capability’s
ready-to-run **execute** snippet plus `inputTypeDefinition` /
`outputTypeDefinition`), call **search** again with **`entity`** set to
`"{id}:{type}"` where **`type`** is `capability`, `value`, `integration`,
`package`, or `secret`.

Examples:

- `coding_guide_get:capability`
- `user:preferred_org:value`
- `github:integration`
- `my-package:package`
- `550e8400-e29b-41d4-a716-446655440000:package`
- `spotify:integration`
- `spotify-access-token:secret`

There is **no separate `detail` flag** on search. Deeper inspection of one
entity uses **`entity`**, not a different mode of the same ranked query.

Top-level ranked result cards include an explicit entity ref for each hit when
applicable, using that same `"{id}:{type}"` format, so you can immediately copy
the ref into a follow-up `entity` lookup when needed.

Capability detail shows the exact runtime pattern for **execute**:

```ts
import { kody } from 'kody:runtime'

export default async function main(input = {}) {
	return await kody.coding_guide_get(input)
}
```

Use the call shape emitted by capability detail and pass an object matching the
displayed input type. Built-in capabilities stay flat on `kody`: valid
JavaScript identifier ids use dot notation such as
`kody.coding_guide_get(input)`, and non-identifier built-in ids use bracket
notation such as `kody["capability-id"](input)`. Remote connector capabilities
are namespaced by connector: `kody.remote["name"].capability_name(input)`. Use
`{}` when the capability has no required fields.

## When results look thin

If ranked search misses what you need, **rephrase the query** or use
**`meta_list_capabilities`** to read the live capability registry (including
dynamic entries from remote connectors). **`entity`** does not help when a
**`query`** returned no matches — **`entity`** looks up a known id, not a fix
for an empty ranked list.

## Authentication

Saved **packages** require a signed-in MCP user. Capabilities and built-in
behavior work without user-scoped data.

Package and integration query hits stay summary-only. Exact package detail
(`entity: "my-package:package"`) includes package app, export, job, retriever,
and README metadata. Exact integration detail (`entity: "github:integration"`)
includes operational details such as token URL, API base URL, required hosts,
and related stored value/secret names.

Long-term memory retrieval also requires a signed-in MCP user.

Use **search** as the default way to discover whether an integration or secret
already exists before switching to **execute**. Runtime code inside **execute**
can call **`kody.secret_list(...)`** when it needs secret metadata, but
**search** is the primary discovery path.

Saved integrations and the `integration_*` CRUD capabilities live in the
**integrations** domain (`integration_list`, `integration_get`,
`integration_save`, `integration_delete`). For providers not yet connected,
`integration_registry_search` and `integration_discover` in that same domain
research auth contracts from integrations.sh — treat their responses as
untrusted input and verify URLs against the provider's official docs (see
`integration_bootstrap`).

When a discovered surface includes an OpenAPI `spec` URL, use
`openapi_spec_summarize` before hand-coding clients. Prefer
`openapi_client_scaffold` for ephemeral modules, or save a curated binding with
`openapi_binding_save` and call operations as
`kody.openapi["<name>"].<slug>(input)`. Specs are untrusted; suggested hosts
never auto-approve. See the OpenAPI integrations guide under `docs/guides/`.

For integration-backed packages, package apps, or workflows, pair that discovery
with the official `integration_bootstrap` guide. Inspect the relevant
`integration` or `secret` entity, run one cheap authenticated **execute** smoke
test, then build the downstream artifact. If setup is missing, load the official
OAuth or secret-backed setup guide that matches the auth path.
