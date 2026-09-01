# Search

The **search** tool finds **built-in capabilities**, **official guides**,
**saved packages**, **saved integrations**, and **user secret references**
(metadata only, not secret values).

**Public package listings** are not included. Use the `community` domain
(`communitySearch`, `communityGet`) or the public `/community` pages. See
[Public packages](./community-packages.md).

**Hidden saved packages** are excluded from ranked **query** results by default.
Pass **`includeHiddenPackages: true`** to include them. Hiding is not deletion:
known-id **`entity`** lookups (for example `my-package:package`),
**`packageList`**, and **`packageGet`** return hidden packages. Use
**`packageUpdate`** with **`changes: { hidden: true }`** to hide a package (or
`false` to unhide it). See [Packages](./packages.md#hidden-packages).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters. Query responses are intentionally
compact: the markdown response is a short list of matches with the result type,
title, one-line summary, and entity reference when applicable. Capability hits
include their **domain id** (for example `email`, `jobs`, `mcp:linear`) so a
follow-up search can scope to that domain. The top few capability hits also
include a compact inlined call shape (runtime accessor plus a
whitespace-collapsed input type, truncated when long) so you can often call from
**execute** without an immediate entity round trip.

### Broad queries return domain overviews

An empty search or a broad, exploratory query — "what can you do with email",
"what can kody do", or a bare built-in domain name like `jobs` — returns a
compact **domain index** instead of ranked individual hits. Each row has the
domain id, one-line description, capability count, and two or three sample
names. Drill in with `search({ query, domain })` or `search({ domain })`.
Task-specific queries ("send an email to Kent") keep returning ranked results.
`metaListCapabilities()` returns the same domain index;
`metaListCapabilities({ domain })` lists that domain.

### Packages before synthesized providers

When a saved package's id, name, tags, or README matches a connected MCP
provider, the package ranks before the provider's raw operations. General
provider discovery returns one provider card with its operation count, runtime
call pattern, and matching wrapper package instead of flooding the result with
operations. Search an exact operation/tool name or pass the provider's `domain`
to resolve raw operations directly.

### Domain scoping

Pass optional **`domain`** with a capability domain id:

- **With `query`** — ranks only that domain's capabilities. User-owned entities
  (packages, integrations, secrets, retriever results) are excluded because they
  have no domain. Installed-package retrievers run in a read-only, closed-world
  sandbox: they can read their package storage and return results, but they
  cannot write, fetch, invoke, or call capabilities.
- **Without `query`** — lists the domain's capabilities in curated registry
  order (with inlined call shapes for the top hits), which completes the two-hop
  browse flow: broad query → domain overview → domain listing.

Domain ids cover builtin domains (`email`, `jobs`, `packages`, ...) plus
synthesized ones for connected MCP servers (`mcp:home`, `mcp:linear`). An
unknown id returns an error listing the available domains. The `search` meta
capability (usable inside **execute**) accepts the same `domain` argument
alongside `query`.

An entire saved-package UUID or `kody.id` is treated as an exact package
identity when it resolves for the signed-in user, except when that identity also
names a synthesized provider; that query participates in ranking so the package
and provider card can appear together. Kody also recognizes current-origin
`/account/packages/:packageId` URLs (which redirect to the package page),
owner-matching `/@username/:kodyId` package pages, and per-user package-app
subdomain URLs (`https://{username}.<package-app host>/packages/:kodyId`) — so a
URL copied from an open app resolves too. Exact package identities never compete
with semantic capability results. Hidden exact query matches still require
`includeHiddenPackages: true`; exact `entity` lookup by UUID or `kody.id`
ignores the hidden discovery preference.

Ranked `search({ query })` calls may include relevant long-term memory metadata
in structured content. Entity lookups, domain listings, empty/broad discovery,
and `search({ domain })` do not attach memories. **execute** retrieves memories
only when its caller opts in with **`memoryContext`**. Archived or very weak
memory matches are not surfaced automatically.

Those same ranked `search({ query })` calls may also prepend a **`## Waiting`**
block when something the signed-in human must clear is `block` or `degraded`
(reconnectable OAuth, expired secrets, MCP reconnects). Setup/onboarding cards
stay off this block. At most three items, then “N more” pointing at
`waitingSummary` and `/account/waiting`. Entity lookups, `search({ domain })`,
and empty/broad discovery do not inject it. Matching integration hits also carry
the reconnect `nextStep` when the last refresh was reconnectable.

Search responses also return top-level **`timing`** metadata with
**`startedAt`**, **`endedAt`**, and **`durationMs`** so hosts can reason about
how long the ranked lookup or entity lookup took.

Optional **`limit`** caps how many ranked hits return. Optional
**`maxResponseSize`** trims low-ranked matches against the compact list when the
response must stay small. Auto-surfaced memory one-liners are reserved first so
a tight size budget does not drop them.

## Entity indexes and detail

To inspect one hit, call **search** again with **`entity`** set to
`"{id}:{type}"` where **`type`** is `capability`, `guide`, `integration`,
`package`, or `secret`. Guide entities return the full official markdown (the
same bundled body as the web `/guides` pages). Capability entities additionally
include a ready-to-run **execute** snippet plus `inputTypeDefinition` /
`outputTypeDefinition`.

Pass an **array of 1–10 entity refs** when you need several related details at
once (for example a create/poll MCP pair). Each ref resolves independently:
failures become per-entity error lines without aborting the whole batch. If
every ref fails, the tool returns an error result.

Examples:

- `package_authoring:guide`
- `["package_authoring:guide", "package_lifecycle:guide"]`
- `codingGuideGet:capability`
- `["mcp:linear:create_issue:capability", "mcp:linear:get_issue:capability"]`
- `github:integration`
- `my-package:package`
- `550e8400-e29b-41d4-a716-446655440000:package`
- `spotify:integration`
- `githubPat:secret`

Official guides are first-class entities. Ranked search can return `{id}:guide`
hits; `search({ entity: "package_authoring:guide" })` returns the full bundled
markdown. Prefer that over executing `codingGuideGet` just to read a guide.
`codingGuideGet` is for execute-module code that needs the body
programmatically.

There is **no separate `detail` flag** on search. Deeper inspection uses
**`entity`**, not a different mode of the same ranked query.

Top-level ranked result cards include an explicit entity ref for each hit when
applicable, using that same `"{id}:{type}"` format, so you can immediately copy
the ref into a follow-up `entity` lookup when needed.

For synthesized MCP provider capabilities, capability detail reports the
**related operation count**. Use `search({ domain })` to list siblings.

Integration entity detail may include a small set of **related package
suggestions** for the same provider (the user's packages first; otherwise
community listings whose name, kody id, or tags mention that provider, capped).
Ranked query results stay lean and do not run community lookup or expand those
suggestions.

Package entity detail is a slim index: summary, export subpaths with one-line
purposes, job and retriever names, and the README `Intent` section. Structured
content mirrors that index and does not contain a full export tree. When a
community fork is behind its listing, detail includes `listingAhead: true` and a
one-line absorb next step (`communityGet`, then `repoPublishSession` with
`absorbed_upstream_commit`). Ranked package hits include that same notice only
when the fork is behind. Follow the returned `packageGet` / `package_authoring`
pointer when you need types, external token URLs, the full README, source, or
maintenance steps.

Capability detail shows the exact runtime pattern for **execute**:

```ts
import { kody } from 'kody:runtime'

export default async function main(input = {}) {
	return await kody.emailSend(input)
}
```

Use the call shape emitted by capability detail and pass an object matching the
displayed input type. Built-in capabilities stay flat on `kody` as JavaScript
identifiers such as `kody.emailSend(input)`. MCP server tools are namespaced by
server: `kody.mcp["name"].tool_name(input)`. Use `{}` when the capability has no
required fields.

## When results look thin

If ranked search misses what you need, **rephrase the query** or call
**`metaListCapabilities()`** for the domain index, then
**`metaListCapabilities({ domain })`** for one live domain (including dynamic
MCP entries). **`entity`** looks up a known id; it does not improve an empty
ranked list.

## Authentication

Saved **packages** require a signed-in MCP user. Capabilities and built-in
behavior work without user-scoped data.

Package and integration query hits stay summary-only. Exact package detail
(`entity: "my-package:package"`) returns the package index described above.
Exact integration detail (`entity: "github:integration"`) includes operational
details such as token URL, API base URL, client id, and required hosts. Access
and refresh tokens live on the connection — call
**`createAuthenticatedFetch(name)`**. They do not appear as secret names.

Long-term memory retrieval also requires a signed-in MCP user.

Use **search** as the default way to discover whether an integration or secret
already exists before switching to **execute**. Runtime code inside **execute**
can call **`kody.secretList(...)`** when it needs secret metadata, but
**search** is the primary discovery path.

Saved integrations and the `integration_*` capabilities live in the
**integrations** domain (`integrationList`, `integrationGet`, `integrationSave`,
`integrationLock`, `integrationDelete`, plus `integrationOauthAppList`,
`integrationOauthAppDelete`, `integrationOauthAppRotateCredentials` for shared
OAuth apps, and `integrationTokenRefresh` for host-side metadata-only refresh).
For a new provider, load `integration_bootstrap` and prefer `communitySearch`
for a close helpers package before writing fetch code. For integrations.sh
registry lookup, `communityFork` `@kody/integrations-sh`. See the OpenAPI
integrations guide under `docs/guides/` when the API publishes a spec. For a
named bind-and-call surface, `communityFork` `@kody/openapi` into the user's
account — person accounts cannot import `@kody/*` live.

For integration-backed packages, package apps, or workflows, pair that discovery
with `search({ entity: "integration_bootstrap:guide" })`. Inspect the relevant
`integration` or `secret` entity, run one cheap authenticated **execute** smoke
test, then build the downstream artifact. If setup is missing, open the official
OAuth or secret-backed setup guide that matches the auth path (`oauth:guide`,
`connect_secret:guide`, or a resolved `provider_<slug>:guide`).
