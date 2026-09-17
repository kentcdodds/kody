# Search entity plugins

Search list results are built from ordered entity plugins under
`packages/worker/src/mcp/tools/search-entity-plugins/`.

The plugin registry is the discovery/candidate/format seam, but a new entity
type is **not** only a plugin registration yet. Closed TypeScript unions,
Markdown list formatting, and detail resolution still need parallel updates.

To add a search entity:

1. Add one lower-kebab-case module in `search-entity-plugins/`.
2. Export a `SearchEntityPlugin` with the entity `type`.
3. Implement the applicable hooks:
   - `buildDescriptors` for `understandSearchQuery` entity hints.
   - `buildCandidates` for list-search candidates.
   - `formatSlimMatch` for structured list results only
     (`toSlimStructuredMatches` / `SlimSearchMatch`). It does **not** cover
     Markdown list output.
   - `formatEntityDetail` only when `search({ entity })` supports that type.
4. Register the plugin once in `search-entity-registry.ts`, in the intended
   flatten order.
5. Extend the closed unions in `search-format-types.ts`, keeping these groups
   separate:
   - Always required for any list/result type (including result-only types such
     as `retriever_result` and `domain`): `SearchMatchType`, `SearchMatch`, and
     `SlimSearchMatch`.
   - Entity-backed only (types accepted by `{type}:{id}` / entity detail):
     `SearchEntityType`, `SearchEntityDetail`, and related
     `SearchEntityDetailStructured` variants as needed.
6. Update Markdown list formatting in `search-format-list.ts`
   (`formatMatchListItem` used by `formatSearchMarkdown`) for the new type.
   Plugin `formatSlimMatch` alone is not enough for agent-visible list text.
7. Teach `resolveEntityDetail` in `search-detail.ts` how to load that entity
   when `search({ entity })` should support it (skip for result-only types such
   as `retriever_result`).
8. Update `parseEntityRef` in `search-format-helpers.ts` so `{type}:{id}`
   parsing accepts the new entity-backed type (first `:` is the type; the id may
   contain colons). Reject `{id}:{type}` refs with an error that shows
   `{type}:{id}`. Guide and package entity refs also accept a hash fragment
   (`guide:{id}#{slug}`, `package:{id}#{subpath}`); other types reject fragments
   in `resolveEntityDetail`.
9. For entity-backed types, update the public allowed-type lists so agents and
   docs stay in sync:
   - `search-tool-definition.ts` (tool description and `entity` input schema
     copy that enumerates `capability` | `guide` | `integration` | `mcp-server`
     | `package` | `secret`)
   - `docs/use/search.md` (user-facing `{type}:{id}` type list)
10. Add or update `search-entity-registry.node.test.ts` to prove the registry
    order and whether the type is entity-backed.

Current candidate flatten order is:

1. `capability`
2. `guide`
3. `package`
4. `integration`
5. `secret`
6. `retriever_result`

`domain` is registered last as a result-only plugin (slim formatting only): its
rows come from the broad-query domain overview in `searchUnified`, not from the
candidate pipeline.

Keep ranking, scoring, and output formatting changes out of plugin seam work
unless the behavior change is explicitly requested.
