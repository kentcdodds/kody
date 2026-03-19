# Adding capabilities

Kody exposes a compact MCP surface (`search` and `execute`) and keeps the real
capability graph behind that surface. To add a new capability, add it to the
internal registry instead of registering a new public MCP tool.

## Capability shape

Each capability lives in a domain folder under `mcp/capabilities/` and exports a
normalized capability created by `defineCapability()` from
`mcp/capabilities/define-capability.ts`.

Required fields:

- `name`: snake_case capability name exposed through `search` and `execute`
- `domain`: stable domain used for organization and search filtering
- `description`: capability description shown to the model
- `inputSchema`: Zod or plain JSON Schema
- `handler(args, ctx)`: async host-side implementation

Optional fields:

- `outputSchema`: Zod or plain JSON Schema describing the structured result
- `tags`: short labels that improve search precision
- `keywords`: extra synonyms or task words that may not belong in the name
- `readOnly`, `idempotent`, `destructive`: search hints for capability behavior

Capabilities should usually be authored with Zod schemas and wrapped with
`defineCapability()` from `mcp/capabilities/define-capability.ts`. The helper:

- converts Zod schemas to JSON Schema for Code Mode and MCP descriptions
- parses Zod input before your handler runs
- parses Zod output before the result is returned

Keep `description` concise. Prefer putting field-level examples, constraints,
and shape details in the schemas rather than repeating them in the top-level
capability description. Reserve the description for high-level purpose and
behavior that the schemas do not express well.

Use raw JSON Schema only when you need an escape hatch that Zod does not model
cleanly. The registry and Code Mode layer still consume normalized JSON Schema
after `defineCapability()` runs.

## Directory layout

Organize capabilities by domain:

```text
mcp/capabilities/
  math/
    do-math.ts
    index.ts
  storage/
    read-bucket-object.ts
    index.ts
  registry.ts
  types.ts
```

Use an existing domain when the capability clearly belongs there. Create a new
domain when the capability introduces a new system boundary or ownership area
such as `calendar/`, `email/`, `storage/`, `cloudflare/`, or `sandbox/`.

## How to add one

1. Create the capability file in the right domain folder.
2. Set a `domain` and add helpful `tags`/`keywords` when they improve search.
3. Define `inputSchema` and optional `outputSchema` with Zod.
4. Wrap the capability with `defineCapability()`.
5. Export it from the domain `index.ts` barrel.
6. Import the domain barrel in `mcp/capabilities/registry.ts`.
7. Add or update tests in `mcp/mcp-server-e2e.test.ts`.

Example shape:

```ts
const inputSchema = z.object({
	name: z.string().min(1),
})

const outputSchema = z.object({
	ok: z.boolean(),
})

export const exampleCapability = defineCapability({
	name: 'example_action',
	domain: 'example',
	description: 'Example capability.',
	tags: ['example'],
	keywords: ['demo'],
	inputSchema,
	outputSchema,
	async handler(args, ctx) {
		void ctx
		return { ok: args.name.length > 0 }
	},
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

Prefer E2E tests in `mcp/mcp-server-e2e.test.ts` over testing the registry shape
in isolation. This keeps the tests focused on the real MCP contract.

## Naming

- Use snake_case capability names.
- Keep names action-oriented and specific.
- Add a domain prefix only when it prevents ambiguity.
- Avoid introducing new public MCP tool names for individual capabilities.
