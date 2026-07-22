# Search entity plugins

Search list results are built from ordered entity plugins under
`packages/worker/src/mcp/tools/search-entity-plugins/`.

The plugin registry is the discovery/candidate/format seam, but a new entity
type is **not** only a plugin registration yet. Closed TypeScript unions and
detail resolution still need parallel updates.

To add a search entity:

1. Add one lower-kebab-case module in `search-entity-plugins/`.
2. Export a `SearchEntityPlugin` with the entity `type`.
3. Implement the applicable hooks:
   - `buildDescriptors` for `understandSearchQuery` entity hints.
   - `buildCandidates` for list-search candidates.
   - `formatSlimMatch` for structured list results.
   - `formatEntityDetail` only when `search({ entity })` supports that type.
4. Register the plugin once in `search-entity-registry.ts`, in the intended
   flatten order.
5. Extend the closed unions in `search-format-types.ts` (`SearchEntityType`,
   `SearchMatch`, `SlimSearchMatch`, `SearchEntityDetail`, and related detail
   structured types as needed).
6. Teach `resolveEntityDetail` in `search-detail.ts` how to load that entity
   when `search({ entity })` should support it (skip for result-only types such
   as `retriever_result`).
7. Update `parseEntityRef` in `search-format-helpers.ts` so `{id}:{type}`
   parsing accepts the new entity-backed type.
8. Add or update `search-entity-registry.node.test.ts` to prove the registry
   order and whether the type is entity-backed.

Current candidate flatten order is:

1. `capability`
2. `package`
3. `value`
4. `integration`
5. `secret`
6. `retriever_result`

Keep ranking, scoring, and output formatting changes out of plugin seam work
unless the behavior change is explicitly requested.
