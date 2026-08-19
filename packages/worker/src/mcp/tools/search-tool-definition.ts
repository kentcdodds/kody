import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { maxBatchEntityRefs } from './search-constants.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
} from './tool-call-context.ts'

export const searchTool = {
	name: 'search',
	title: 'Search Capabilities, Packages, Values, Integrations, and Secrets',
	description: `
Find **built-in capabilities**, **saved packages**, **persisted values**,
**saved integrations**, and **user secret references** (metadata only)
before \`execute\`.

**query** — compact ranked markdown + structured matches (order matters). Query
markdown is summary-only: type, title/name, one-line description, and entity ref.
An empty call and broad/exploratory queries ("what can you do with email")
return a compact **domain index** instead of individual hits; drill in with
\`domain\`. General provider-name discovery returns one provider card and ranks
a matching saved wrapper package above raw OpenAPI/MCP operations.

**domain** — optional capability domain id (e.g. \`email\`, \`jobs\`,
\`mcp:linear\`). With \`query\`, ranks only that domain's
capabilities. Without \`query\`, lists the domain's capabilities in curated
order. Domain ids appear on every capability hit and in domain summaries.

An entire saved-package UUID, kody id, current-origin account package URL, or
owner-matching hosted package URL resolves as exact user-scoped package identity
without competing semantic matches. Hidden exact queries require
\`includeHiddenPackages: true\`.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`value\`
| \`integration\` | \`package\` | \`secret\`), or an array of 1–10 refs to batch
related lookups in one call. Package detail defaults to a slim index (export
subpaths, job/retriever names, README Intent). Capability detail includes an
exact \`execute\` module snippet plus TypeScript call-shape definitions.
Synthesized provider detail reports its related-operation count. Integration
detail may include a small set of
same-provider package suggestions (user packages first, else trusted-first
community listings). Package ids may be UUIDs or kody ids, and hidden packages
resolve here regardless of \`includeHiddenPackages\`.

Secret results expose metadata only; credential values never appear.

If results look incomplete: \`meta_list_capabilities()\` for a domain index,
then \`meta_list_capabilities({ domain })\` for one domain.

Optional **limit** (default 15) and **maxResponseSize** trim low-ranked results.
Example arguments:
- \`{ "query": "saved github automation package", "limit": 10 }\`
- \`{}\`
- \`{ "query": "send a message", "domain": "email" }\`
- \`{ "domain": "jobs" }\`
- \`{ "entity": "coding_guide_get:capability" }\`
- \`{ "entity": ["openapi:canva:createdesignexportjob:capability", "openapi:canva:getdesignexportjob:capability"] }\`
- \`{ "entity": "user:preferred_org:value" }\`
- \`{ "entity": "github:integration" }\`

https://github.com/kentcdodds/kody/blob/main/docs/use/search.md
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

export const searchToolInputSchema = {
	query: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Natural language description, or an exact saved-package UUID, kody id, current-origin account package URL, or owner-matching hosted package URL.',
		),
	entity: z
		.union([
			z.string().min(1),
			z.array(z.string().min(1)).min(1).max(maxBatchEntityRefs),
		])
		.optional()
		.describe(
			'Optional exact entity reference "{id}:{type}" (capability, package, secret, value, or integration), or an array of 1–10 refs to batch related detail lookups.',
		),
	domain: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional capability domain id (for example "email" or "mcp:linear"). With "query", ranks only that domain\'s capabilities; without "query", lists the domain\'s capabilities.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Max number of ranked results to return. Defaults to 15.'),
	maxResponseSize: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			'Max response size in characters before trimming low-ranked results. Defaults to 4000.',
		),
	conversationId: conversationIdInputField,
	memoryContext: memoryContextInputField,
	includeHiddenPackages: z
		.boolean()
		.optional()
		.describe(
			'Include hidden packages in search results (hidden packages are excluded by default).',
		),
}

/**
 * Advertised MCP output schema for the search tool's `structuredContent`
 * envelope. Deliberately loose: every field is optional and compound values
 * are `z.unknown()`, so server-side output validation (which runs on every
 * successful call once a schema is advertised) can never reject a real
 * response. The schema documents the envelope for clients; mode-specific
 * payload shapes stay in the tool description and docs.
 */
export const searchToolOutputSchema = {
	conversationId: z
		.string()
		.optional()
		.describe(
			'Tool conversation id; pass it back on subsequent search/execute calls.',
		),
	timing: z
		.unknown()
		.optional()
		.describe(
			'Server-side timing: startedAt, endedAt, durationMs, optional serverTiming phases.',
		),
	result: z
		.unknown()
		.optional()
		.describe(
			'Mode-specific structured payload: ranked matches with telemetry, domain browse listing, entity detail, or entity-batch results.',
		),
	error: z
		.string()
		.optional()
		.describe('Error summary when the search failed (isError is set).'),
}

export type SearchToolArgs = {
	query?: string
	entity?: string | Array<string>
	domain?: string
	limit?: number
	maxResponseSize?: number
	conversationId?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
	includeHiddenPackages?: boolean
}
