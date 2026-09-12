import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { maxBatchEntityRefs } from './search-constants.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
} from './tool-call-context.ts'

export const searchTool = {
	name: 'search',
	title: 'Search Capabilities, Guides, Packages, Integrations, and Secrets',
	description: `
Find built-in capabilities, official guides, saved packages, integrations, connected MCP servers, and secret references (metadata only) before \`execute\`.

**query** — compact ranked markdown + structured matches. Empty or broad queries return a domain index; search again with a more specific query. Domain ids appear on capability hits. Connected MCP servers appear as server hits (name, instructions); do not expect every remote tool in unscoped results.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`guide\` | \`integration\` | \`mcp-server\` | \`package\` | \`secret\`), or 1–10 refs. Guide detail is the full markdown when it fits the response budget; oversized guides return a table of contents. Open a heading with \`{id}:guide#{slug}\` (for example \`package_subscriptions:guide#repo.pushed\`). Capability detail includes an execute snippet. MCP server detail lists discovered tools; after that, call \`kody.mcp["name"].tool_name(args)\`.

Example arguments:
- \`{ "query": "send a message" }\`
- \`{}\`
- \`{ "query": "send a message", "domain": "email" }\`
- \`{ "domain": "jobs" }\`
- \`{ "entity": "package_authoring:guide" }\`

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
			'Natural language description, or a scoped `@owner/leaf` name, current-origin account package URL, owner-matching hosted package URL, or an exact saved-package UUID (`package_id`) when the name is not known.',
		),
	entity: z
		.union([
			z.string().min(1),
			z.array(z.string().min(1)).min(1).max(maxBatchEntityRefs),
		])
		.optional()
		.describe(
			'Optional exact entity reference "{id}:{type}" (capability, guide, integration, mcp-server, package, or secret), or an array of 1–10 refs to batch related detail lookups. Guide refs accept "#{heading}" to open one section. Use "{name}:mcp-server" to list tools on a connected MCP server.',
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
	entitlement: z
		.unknown()
		.optional()
		.describe(
			'Focused plan-limit or quota fields when a call is denied. Omitted from ordinary successes.',
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
