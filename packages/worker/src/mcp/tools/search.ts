import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { searchUnified } from '#mcp/capabilities/unified-search.ts'
import { listMcpSkillsByUserId } from '#mcp/skills/mcp-skills-repo.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { listUiArtifactsByUserId } from '#mcp/ui-artifacts-repo.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type MCP } from '#mcp/index.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken

function truncateSearchResult(value: unknown): string {
	const text =
		typeof value === 'string'
			? value
			: (JSON.stringify(value, null, 2) ?? 'undefined')

	if (text.length <= maxChars) return text

	return `${text.slice(0, maxChars)}\n\n--- TRUNCATED ---\nResponse was ~${Math.ceil(
		text.length / charsPerToken,
	).toLocaleString()} tokens (limit: ${maxTokens.toLocaleString()}). Lower the limit or ask a shorter query.`
}

const searchTool = {
	name: 'search',
	title: 'Search Capabilities And Skills',
	description: `
Search Kody **builtin capabilities**, your saved **skills** (meta domain), and your saved **apps** (apps domain) by natural language before calling \`execute\` or opening a UI.

Each match has **type** \`capability\`, \`skill\`, or \`app\`. To run a saved skill, call \`meta_run_skill\` with the \`skill_id\` and optional \`params\`. If you need to inspect the code, call \`meta_get_skill\` and then pass its code to \`execute\`. To reopen a saved app, call \`open_generated_ui\` with the \`app_id\`. Saved skills should be **reasonably repeatable** workflows; one-off work belongs in \`execute\`, not persisted as a skill. Saved apps are reusable UI artifacts and can be reopened without resending their source code through the model.

If search results seem incomplete, call \`meta_list_capabilities\` to inspect the exact current runtime capability registry (including dynamic capabilities such as connected home tools), then use \`execute\` to filter or plan from that list.

Domains (for context only—put hints in your \`query\` string; there are no filter fields):
- \`math\`: Simple arithmetic and calculator-style operations over numbers.
- \`coding\`: Software work such as GitHub repository actions, issues, pull requests, Cursor Cloud Agents API calls, Cloudflare API calls, and related docs/coding workflows.
- \`meta\`: Persisted and reusable codemode skills plus skill management.
- \`home\`: Home automation capabilities discovered from the connected home connector when available.

Pass a **query** string describing what you want to do. Results are ranked with semantic (Vectorize) and lexical fusion. **Skills** require an authenticated MCP user.

Optional **limit** (default 15) caps how many results are returned. **detail: true** includes extra metadata (for skills: inferred capabilities, etc.; for capabilities: JSON schemas where applicable).

Example arguments:
- \`{ "query": "saved interactive dashboard app", "limit": 10 }\`
- \`{ "query": "call GitHub REST API", "detail": true }\`
- To run a skill: \`meta_run_skill({ "skill_id": "<id>", "params": { "owner": "kentcdodds" } })\`
- To reopen a saved app: \`open_generated_ui({ "app_id": "<id>" })\`
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

const defaultSearchLimit = 15

type OptionalSearchRowsResult = {
	skillRows: Array<McpSkillRow>
	uiArtifactRows: Array<UiArtifactRow>
	warnings: Array<string>
}

export async function loadOptionalSearchRows(input: {
	userId: string | null
	loadSkills: () => Promise<Array<McpSkillRow>>
	loadUiArtifacts: () => Promise<Array<UiArtifactRow>>
}): Promise<OptionalSearchRowsResult> {
	if (!input.userId) {
		return {
			skillRows: [],
			uiArtifactRows: [],
			warnings: [],
		}
	}

	const warnings: Array<string> = []
	let skillRows: Array<McpSkillRow> = []
	let uiArtifactRows: Array<UiArtifactRow> = []

	try {
		skillRows = await input.loadSkills()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warnings.push(`Saved skills are temporarily unavailable: ${message}`)
	}

	try {
		uiArtifactRows = await input.loadUiArtifacts()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warnings.push(`Saved apps are temporarily unavailable: ${message}`)
	}

	return {
		skillRows,
		uiArtifactRows,
		warnings,
	}
}

export async function registerSearchTool(agent: MCP) {
	agent.server.registerTool(
		searchTool.name,
		{
			title: searchTool.title,
			description: searchTool.description,
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe('Natural language description of the capability you need.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe('Max number of results to return (default 15).'),
				detail: z
					.boolean()
					.optional()
					.describe('Include full metadata / schemas when true.'),
			},
			annotations: searchTool.annotations,
		},
		async (args: { query: string; limit?: number; detail?: boolean }) => {
			const startedAt = performance.now()
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const userId = callerContext.user?.userId ?? null
			let warnings: Array<string> = []

			const searchSpan = async () => {
				const registry = await getCapabilityRegistryForContext({
					env: agent.getEnv(),
					callerContext,
				})
				const optionalRows = await loadOptionalSearchRows({
					userId,
					loadSkills: () =>
						listMcpSkillsByUserId(agent.getEnv().APP_DB, userId!),
					loadUiArtifacts: () =>
						listUiArtifactsByUserId(agent.getEnv().APP_DB, userId!),
				})
				warnings = optionalRows.warnings
				return searchUnified({
					env: agent.getEnv(),
					query: args.query,
					limit: args.limit ?? defaultSearchLimit,
					detail: args.detail === true,
					specs: registry.capabilitySpecs,
					userId,
					skillRows: optionalRows.skillRows,
					uiArtifactRows: optionalRows.uiArtifactRows,
				})
			}

			let result: Awaited<ReturnType<typeof searchUnified>>
			try {
				result = await Sentry.startSpan(
					{
						name: 'mcp.tool.search',
						op: 'mcp.tool',
						attributes: {
							'mcp.tool': 'search',
						},
					},
					searchSpan,
				)
			} catch (cause) {
				const durationMs = Math.round(performance.now() - startedAt)
				const error = cause instanceof Error ? cause : new Error(String(cause))
				const { errorName, errorMessage } = errorFields(error)
				logMcpEvent({
					category: 'mcp',
					tool: 'search',
					toolName: 'search',
					outcome: 'failure',
					durationMs,
					baseUrl,
					hasUser,
					sandboxError: false,
					errorName,
					errorMessage,
					cause: error,
				})
				return {
					content: [{ type: 'text', text: `Error: ${error.message}` }],
					structuredContent: {
						error: error.message,
					},
					isError: true,
				}
			}

			const durationMs = Math.round(performance.now() - startedAt)

			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'success',
				durationMs,
				baseUrl,
				hasUser,
			})

			const payload = {
				matches: result.matches,
				offline: result.offline,
				warnings,
			}

			return {
				content: [
					{
						type: 'text',
						text: truncateSearchResult(payload),
					},
				],
				structuredContent: {
					result: payload,
				},
			}
		},
	)
}
