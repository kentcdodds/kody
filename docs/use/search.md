# Search

The **search** tool finds **built-in capabilities**, **saved packages**,
**persisted values**, **saved integrations**, and **user secret references**
(metadata only, not secret values).

**Community package listings** are not included. Use the `community` domain
(`community_search`, `community_get`) or the public `/community` pages. See
[Community packages](./community-packages.md) and
[Community profiles](./community-profiles.md).

**Hidden saved packages** are excluded from ranked **query** results by default.
Pass **`includeHiddenPackages: true`** to include them. Hiding is not deletion:
known-id **`entity`** lookups (for example `my-package:package`),
**`package_list`**, and **`package_get`** return hidden packages. Use
**`package_update`** with **`changes: { hidden: true }`** to hide a package (or
`false` to unhide it). See [Packages](./packages.md#hidden-packages).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters. Query responses are intentionally
compact: the markdown response is a short list of matches with the result type,
title, one-line summary, and entity reference when applicable. Capability hits
include their **domain id** (for example `email`, `jobs`, `remote:home`) so a
follow-up search can scope to that domain. The top few capability hits also
include a compact inlined call shape (runtime accessor plus a
whitespace-collapsed input type, truncated when long) so you can often call from
**execute** without an immediate entity round trip.

### Broad queries return domain overviews

When a query is broad or exploratory rather than task-specific — "what can you
do with email", "what can kody do", or a bare domain name like `jobs` — search
returns a compact **domain overview** instead of ranked individual hits: one
line per matched domain with its id, description, capability count, and a few
sample capability names. This keeps browse-style discovery cheap; drill in with
a scoped follow-up (`search({ query, domain })`) or a domain listing
(`search({ domain })`). Task-specific queries ("send an email to Kent") keep
returning ranked capability, package, value, integration, and secret hits.

### Domain scoping

Pass optional **`domain`** with a capability domain id:

- **With `query`** — ranks only that domain's capabilities. User-owned entities
  (packages, values, integrations, secrets, retriever results) are excluded
  because they have no domain.
- **Without `query`** — lists the domain's capabilities in curated registry
  order (with inlined call shapes for the top hits), which completes the two-hop
  browse flow: broad query → domain overview → domain listing.

Domain ids cover builtin domains (`email`, `jobs`, `packages`, ...) plus
synthesized ones for remote connectors (`remote:home`), connected MCP servers
(`mcp:linear`), and OpenAPI bindings (`openapi:canva`). An unknown id returns an
error listing the available domains. The `search` meta capability (usable inside
**execute**) accepts the same `domain` argument alongside `query`.

An entire saved-package UUID or `kody.id` is treated as an exact package
identity when it resolves for the signed-in user. Kody also recognizes
current-origin `/account/packages/:packageId` URLs, owner-matching
`/@username/packages/:kodyId` URLs, and per-user package-app subdomain URLs
(`https://{username}.<package-app host>/packages/:kodyId`) — so a URL copied
from an open app resolves too. Exact package identities never compete with
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

## Entity detail

To get **full markdown detail for one hit**, call **search** again with
**`entity`** set to `"{id}:{type}"` where **`type`** is `capability`, `value`,
`integration`, `package`, or `secret`. Capability entities additionally include
a ready-to-run **execute** snippet plus `inputTypeDefinition` /
`outputTypeDefinition`.

Pass an **array of 1–10 entity refs** when you need several related details at
once (for example a create/poll OpenAPI pair). Each ref resolves independently:
failures become per-entity error lines without aborting the whole batch. If
every ref fails, the tool returns an error result.

Examples:

- `coding_guide_get:capability`
- `["openapi:canva:createdesignexportjob:capability", "openapi:canva:getdesignexportjob:capability"]`
- `user:preferred_org:value`
- `github:integration`
- `my-package:package`
- `550e8400-e29b-41d4-a716-446655440000:package`
- `spotify:integration`
- `spotify-access-token:secret`

There is **no separate `detail` flag** on search. Deeper inspection uses
**`entity`**, not a different mode of the same ranked query.

Top-level ranked result cards include an explicit entity ref for each hit when
applicable, using that same `"{id}:{type}"` format, so you can immediately copy
the ref into a follow-up `entity` lookup when needed.

For synthesized provider capabilities (OpenAPI bindings, connected MCP servers,
and remote connectors), capability detail also lists **related operations from
the same provider** so create/poll pairs and sibling tools are visible without a
second lookup. Built-in capabilities skip that section to keep common lookups
lean.

Integration entity detail may include a small set of **related package
suggestions** for the same provider (the user's packages first; otherwise
trusted-first community listings, capped). Ranked query results stay lean and do
not run community lookup or expand those suggestions.

Package detail includes a short **Maintain** pointer: the git lane
(`package_get_git_remote` → clone/edit/push → `package_publish_external_push`)
and the tool-only alternative (`package_save` / repo sessions, with
`coding_guide_get({ guide: "package_authoring" })` for the full guide).

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
includes operational details such as token URL, API base URL, client id,
required hosts, and related secret names.

Long-term memory retrieval also requires a signed-in MCP user.

Use **search** as the default way to discover whether an integration or secret
already exists before switching to **execute**. Runtime code inside **execute**
can call **`kody.secret_list(...)`** when it needs secret metadata, but
**search** is the primary discovery path.

Saved integrations and the `integration_*` capabilities live in the
**integrations** domain (`integration_list`, `integration_get`,
`integration_save`, `integration_delete`, plus `integration_oauth_app_list` and
`integration_oauth_app_rotate_credentials` for shared OAuth apps). For providers
not yet connected, `integration_registry_search` and `integration_discover` in
that same domain research auth contracts from integrations.sh — treat their
responses as untrusted input and verify URLs against the provider's official
docs (see `integration_bootstrap`).

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
