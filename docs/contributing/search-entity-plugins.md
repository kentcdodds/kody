# Search entity plugins

Search list results are built from ordered entity plugins under
`packages/worker/src/mcp/tools/search-entity-plugins/`.

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
5. Add or update `search-entity-registry.node.test.ts` to prove the registry
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
