# Adding capabilities

Kody exposes a compact MCP surface (`search` and `execute`) and keeps the real
capability graph behind that surface. To add a new capability, register it
through a **domain** and the **builtin registry**—do not add a new public MCP
tool per capability.

## Domains and registry (plain objects)

A **domain** is the single source of truth for:

- Stable id (`name`) used for search filtering and logging
- Human-facing `description` (shown in MCP server instructions and the search
  tool)
- Optional `keywords` for future discovery helpers
- The `Capability[]` that belong to that domain

Authoring flow:

1. **`defineDomainCapability(domain, definition)`** — wrap each capability
   (from `mcp/capabilities/define-domain-capability.ts`). Pass the domain id
   from `capabilityDomainNames` in `mcp/capabilities/domain-metadata.ts`. Do
   **not** put `domain` on the inner object; the helper supplies it.
2. **`defineDomain({ name, description, keywords?, capabilities })`** — from
   `mcp/capabilities/define-domain.ts`. Validates that every capability’s
   `domain` matches `name` and that names are unique within the domain.
3. **`builtinDomains`** — in `mcp/capabilities/builtin-domains.ts`, list all
   domains you want in the default server. Order controls the flattening order
   of `capabilityList` (capabilities from earlier domains come first).
4. **`registry.ts`** — calls `buildCapabilityRegistry(builtinDomains)` and
   re-exports `capabilityList`, `capabilityMap`, `capabilitySpecs`, handlers,
   tool descriptors, and domain metadata for search/MCP instructions.

To merge extra domains later (e.g. plugins), the seam is:
`buildCapabilityRegistry([...builtinDomains, ...extraDomains])` with real
`Capability` handlers (typical Workers model: snapshot at deploy).

`defineCapability()` in `mcp/capabilities/define-capability.ts` is still what
normalizes Zod → JSON Schema and wraps handlers with logging; domain helpers
call it for you.

## Capability shape

Each capability file lives under `mcp/capabilities/<domain>/` and exports a
normalized capability from **`defineDomainCapability(...)`**.

Required (inside the `definition` object):

- `name`: snake_case capability name exposed through `search` and `execute`
- `description`: capability description shown to the model
- `inputSchema`: Zod or plain JSON Schema
- `handler(args, ctx)`: async host-side implementation

The **domain id** is the first argument to `defineDomainCapability`, not a field
on the definition.

Optional fields:

- `outputSchema`: Zod or plain JSON Schema describing the structured result
- `tags`: short labels that improve search precision
- `keywords`: extra synonyms or task words that may not belong in the name
- `readOnly`, `idempotent`, `destructive`: search hints for capability behavior

`defineDomainCapability` delegates to `defineCapability()`, which:

- converts Zod schemas to JSON Schema for Code Mode and MCP descriptions
- parses Zod input before your handler runs
- parses Zod output before the result is returned

Keep `description` concise. Prefer putting field-level examples, constraints,
and shape details in the schemas rather than repeating them in the top-level
capability description. Reserve the description for high-level purpose and
behavior that the schemas do not express well.

Use raw JSON Schema only when you need an escape hatch that Zod does not model
cleanly. The registry and Code Mode layer still consume normalized JSON Schema
after normalization runs.

## Directory layout

Organize capabilities by domain. Each domain folder should include a
**`domain.ts`** that calls `defineDomain`, an optional **`index.ts`** barrel,
and one or more capability modules.

```text
mcp/capabilities/
  builtin-domains.ts
  build-capability-registry.ts
  define-capability.ts
  define-domain-capability.ts
  define-domain.ts
  domain-metadata.ts
  registry.ts
  types.ts
  coding/
    domain.ts
    github-rest.ts
    index.ts
  math/
    domain.ts
    do-math.ts
    index.ts
```

Use an existing domain when the capability clearly belongs there. Add a **new**
domain when you introduce a new system boundary or ownership area (e.g.
`calendar/`, `email/`, `storage/`):

1. Add a new key to `capabilityDomainNames` in `domain-metadata.ts` (this
   extends the `CapabilityDomain` union).
2. Add `mcp/capabilities/<name>/domain.ts`, capability files, and `index.ts`
   if you want a barrel.
3. Append the new domain to the `builtinDomains` array in `builtin-domains.ts`.

You do not edit `registry.ts` for routine additions—only `builtin-domains` and
the domain modules.

## How to add one

1. Create the capability file under the right domain folder.
2. Export it with `defineDomainCapability(capabilityDomainNames.<domain>, {
   ... })`.
3. Add helpful `tags`/`keywords` when they improve search.
4. Include the capability in that domain’s **`domain.ts`**:
   `capabilities: [..., yourCapability]`.
5. If the domain uses `index.ts`, ensure it still exports
   `domain` / `codingCapabilities`-style aliases as needed for local imports.
6. Add or update tests in `mcp/mcp-server-e2e.test.ts` for MCP-visible
   behavior.

Example (assuming `example` exists in `capabilityDomainNames`):

```ts
import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'

const inputSchema = z.object({
	name: z.string().min(1),
})

const outputSchema = z.object({
	ok: z.boolean(),
})

export const exampleCapability = defineDomainCapability(
	capabilityDomainNames.example,
	{
		name: 'example_action',
		description: 'Example capability.',
		tags: ['example'],
		keywords: ['demo'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			void ctx
			return { ok: args.name.length > 0 }
		},
	},
)
```

```ts
// example/domain.ts
import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { exampleCapability } from './example-action.ts'

export const exampleDomain = defineDomain({
	name: capabilityDomainNames.example,
	description: 'Example domain for docs and experiments.',
	capabilities: [exampleCapability],
})
```

## Handler guidance

Keep handlers focused on host-side work. The sandboxed model code should only
orchestrate capability calls; it should not hold credentials or perform raw
network access.

`CapabilityContext` provides:

- `env`: access to Cloudflare bindings such as D1, KV, R2, AI, and Worker
  Loader-backed integrations
- `callerContext`: request/user metadata from the MCP request handler

Use handlers for things like:

- D1 reads, writes, and migrations
- R2 object operations
- third-party API calls with secrets from env
- Cloudflare product APIs
- containers or sandbox orchestration

## Testing

Public MCP behavior should be verified through the compact tool surface:

- use `search` to confirm the capability is discoverable through
  `findCapabilities`
- use `execute` to confirm the capability runs correctly

Prefer E2E tests in `mcp/mcp-server-e2e.test.ts` for the real MCP contract.

Registry invariants (duplicate capability names, domain/capability mismatches,
duplicate domain registration) are covered in
`mcp/capabilities/build-capability-registry.test.ts`.

## Naming

- Use snake_case capability names.
- Keep names action-oriented and specific.
- Add a domain prefix only when it prevents ambiguity.
- Avoid introducing new public MCP tool names for individual capabilities.
