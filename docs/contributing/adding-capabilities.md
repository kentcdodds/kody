# Adding capabilities

User-authored persisted packages and their `package.json#kody` contract are
documented in [`packages-and-manifests.md`](./packages-and-manifests.md).

Secret-bearing outbound requests are governed by
[`secret-host-approval.md`](./secret-host-approval.md). Read that doc before
adding any capability or workflow that saves secrets, uses placeholder-based
`fetch`, or discusses host approval.

Kody exposes a compact MCP surface (`search` and `execute`) and keeps the real
capability graph behind that surface. To add a new capability, register it
through a **domain** and the **builtin registry**—do not add a new public MCP
tool per capability.

## Domains and registry (plain objects)

A **domain** is the single source of truth for:

- Stable id (`name`) used for search ranking and logging
- Human-facing `description` (shown in MCP server instructions and the search
  tool)
- Optional `keywords` — folded into the embed text used for MCP `search`
  (Vectorize + lexical fusion); good keywords improve retrieval
- The `Capability[]` that belong to that domain

Authoring flow:

1. **`defineDomainCapability(domain, definition)`** — wrap each capability (from
   `packages/worker/src/mcp/capabilities/define-domain-capability.ts`). Pass the
   domain id from `capabilityDomainNames` in
   `packages/worker/src/mcp/capabilities/domain-metadata.ts`. Do **not** put
   `domain` on the inner object; the helper supplies it.
2. **`defineDomain({ name, description, keywords?, capabilities })`** — from
   `packages/worker/src/mcp/capabilities/define-domain.ts`. Validates that every
   capability’s `domain` matches `name` and that names are unique within the
   domain.
3. **`builtinDomains`** — in
   `packages/worker/src/mcp/capabilities/builtin-domains.ts`, list all domains
   you want in the default server. Order controls the flattening order of
   `capabilityList` (capabilities from earlier domains come first).
4. **`registry.ts`** — calls `buildCapabilityRegistry(builtinDomains)` and
   re-exports `capabilityList`, `capabilityMap`, `capabilitySpecs`, handlers,
   tool descriptors, and domain metadata for search/MCP instructions.

To merge extra domains later (e.g. plugins), the seam is:
`buildCapabilityRegistry([...builtinDomains, ...extraDomains])` with real
`Capability` handlers (typical Workers model: snapshot at deploy).

**Remote connectors:** at runtime, `getCapabilityRegistryForContext` also merges
domains synthesized from outbound WebSocket connectors (see
[`architecture/remote-connectors.md`](./architecture/remote-connectors.md)).
Those domains are driven by MCP **`remoteConnectors`** / **`homeConnectorId`**
rather than by editing `builtinDomains` in-repo.

`defineCapability()` in
`packages/worker/src/mcp/capabilities/define-capability.ts` is still what
normalizes Zod → JSON Schema and wraps handlers with logging; domain helpers
call it for you.

## Capability shape

Each capability file lives under
`packages/worker/src/mcp/capabilities/<domain>/` and exports a normalized
capability from **`defineDomainCapability(...)`**.

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

## Secret-capable input fields

Some capability input fields may accept secret placeholders such as
`{{secret:lutronUsername}}` or `{{secret:lutronPassword|scope=user}}` instead of
raw strings.

This is an explicit opt-in. A field only participates when its JSON Schema marks
that string property with `x-kody-secret: true`.

At execute time, Kody resolves those placeholders before the capability handler
runs. Missing secrets still fail with the same "secret not found" guidance used
elsewhere, and secret-bearing capability inputs still require an authenticated
user.

Those inputs are also treated as write-only for the rest of that execution: once
plaintext crosses an `x-kody-secret` capability boundary, Kody redacts that
plaintext from later execute results and logs before returning them to the
caller. Capability authors should still avoid returning or logging secret
material, but the runtime adds this extra defense-in-depth layer.

When a secret has an `allowed_capabilities` policy, Kody also checks that the
current capability name is explicitly listed before resolving the placeholder.
An empty `allowed_capabilities` list means no capability is allowed to resolve
the secret until entries are added.

Use this for capabilities that need to accept a secret value as an argument but
are not themselves the host-approval boundary. Good fits include:

- storing or updating credentials on a local connector or device
- writing a secret into local persistence owned by the capability
- passing a credential to a host-side action that does not itself perform
  agent-directed outbound egress

Do not use this as a shortcut for arbitrary remote API calls. If the capability
is making outbound requests with a user secret, prefer execute-time `fetch(...)`
placeholders so host approval still happens through the normal policy path.

Use the shared helper from `@kody-internal/shared/secret-input-schema.ts` rather
than mutating schema properties by hand.

How to annotate:

1. Start with a JSON Schema object for the capability input.
2. Call `markSecretInputFields(schema, [...])` with only the sensitive string
   field names.
3. Leave non-secret fields unannotated.
4. Document the intended use in the capability description when it may not be
   obvious.
5. If the capability persists or hands off a secret value, make the description
   say that the input is write-only and must never be returned to chat.

Example:

```ts
import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'

const inputSchema = markSecretInputFields(
	{
		type: 'object',
		properties: {
			processorId: { type: 'string' },
			username: { type: 'string' },
			password: { type: 'string' },
		},
		required: ['processorId', 'username', 'password'],
	},
	['username', 'password'],
)
```

If you are starting from Zod, call `markSecretInputFields(...)` after
`z.toJSONSchema(...)` produces the schema object. That is what the home
connector does for `lutron_set_credentials`.

## Directory layout

Organize capabilities by domain. Each domain folder should include a
**`domain.ts`** that calls `defineDomain`, an optional **`index.ts`** barrel,
and one or more capability modules.

```text
packages/worker/src/mcp/capabilities/
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
    cloudflare-rest.ts
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
2. Add `packages/worker/src/mcp/capabilities/<name>/domain.ts`, capability
   files, and `index.ts` if you want a barrel.
3. Append the new domain to the `builtinDomains` array in `builtin-domains.ts`.

You do not edit `registry.ts` for routine additions—only `builtin-domains` and
the domain modules.

## How to add one

1. Create the capability file under the right domain folder.
2. Export it with
   `defineDomainCapability(capabilityDomainNames.<domain>, { ... })`.
3. Add helpful `tags`/`keywords` when they improve search.
4. Include the capability in that domain’s **`domain.ts`**:
   `capabilities: [..., yourCapability]`.
5. If the domain uses `index.ts`, ensure it still exports `domain` /
   `codingCapabilities`-style aliases as needed for local imports.
6. Add or update focused `*.node.test.ts` or `*.workers.test.ts` coverage beside
   the implementation for most MCP-visible behavior. Touch
   `packages/worker/src/mcp/*.mcp-e2e.test.ts` only when the behavior truly
   depends on the real MCP transport, OAuth handshake, or hosted package app
   session wiring.

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

For secret-aware outbound requests, treat host approval as admin-only policy. Do
not add MCP-side or execute-time mutation paths for a secret's allowed hosts.
Only the authenticated account admin UI may widen that policy.

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

If a capability surfaces secret metadata or secret-using network behavior, make
the description explicit about the approval model:

- secret save/update does not authorize outbound use
- a blocked host must be approved through the account admin UI
- the agent should stop and surface the approval link instead of retrying

If a capability marks any input fields with `x-kody-secret: true`, keep the
scope narrow:

- annotate only the exact credential fields, not the whole object
- prefer this for local persistence or device-side credential flows
- treat those inputs as write-only even if the runtime redacts accidental echoes
- tell users which capability names should be added to a secret's
  `allowed_capabilities` policy when a workflow depends on restricted secrets
- avoid using it for generic remote API wrappers where fetch-time host approval
  should remain the enforcement point

## Testing

Public MCP behavior should be verified through the compact tool surface:

- use `search` with a **query** string to confirm the capability surfaces in
  ranked results
- use `execute` to confirm the capability runs correctly

Prefer `*.node.test.ts` and `*.workers.test.ts` for capability behavior. Reserve
`packages/worker/src/mcp/*.mcp-e2e.test.ts` for a very small number of real MCP
contract smoke tests.

Registry invariants (duplicate capability names, domain/capability mismatches,
duplicate domain registration) are covered in
`packages/worker/src/mcp/capabilities/build-capability-registry.workers.test.ts`.

Use filename suffixes to choose the Vitest project:

- `*.node.test.ts`: runs in the Node unit project
- `*.workers.test.ts`: runs in the Cloudflare Workers unit project
- `*.mcp-e2e.test.ts`: runs in the dedicated MCP E2E project

## Naming

- Use snake_case capability names.
- Keep names action-oriented and specific.
- Add a domain prefix only when it prevents ambiguity.
- Avoid introducing new public MCP tool names for individual capabilities.
