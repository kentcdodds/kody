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
Broad/exploratory queries ("what can you do with email") return compact
**domain summaries** instead of individual hits; drill in with \`domain\`.
If nothing useful returns, rephrase or call \`meta_list_capabilities\`; \`entity\`
does not fix an empty ranked list.

**domain** — optional capability domain id (e.g. \`email\`, \`jobs\`,
\`remote:home\`, \`mcp:linear\`). With \`query\`, ranks only that domain's
capabilities. Without \`query\`, lists the domain's capabilities in curated
order. Domain ids appear on every capability hit and in domain summaries.

An entire saved-package UUID, kody id, current-origin account package URL, or
owner-matching hosted package URL resolves as exact user-scoped package identity
without competing semantic matches. Hidden exact queries require
\`includeHiddenPackages: true\`.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`value\`
| \`integration\` | \`package\` | \`secret\`), or an array of 1–10 refs to batch
related lookups in one call. Capability detail includes an exact \`execute\`
module snippet plus TypeScript call-shape definitions by default. Synthesized
provider capabilities (OpenAPI, MCP server, remote connector) also list related
operations from the same provider. Integration detail may include a small set of
same-provider package suggestions (user packages first, else trusted-first
community listings). Package ids may be UUIDs or kody ids, and hidden packages
resolve here regardless of \`includeHiddenPackages\`.

Secret results expose metadata only; credential values never appear.

If results look incomplete: \`meta_list_capabilities\` (full registry) or
\`meta_list_remote_connector_status\` (remote connectors).

Optional **limit** (default 15) and **maxResponseSize** trim low-ranked results.
Example arguments:
- \`{ "query": "saved github automation package", "limit": 10 }\`
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
			'Optional capability domain id (for example "email" or "remote:home"). With "query", ranks only that domain\'s capabilities; without "query", lists the domain\'s capabilities.',
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
