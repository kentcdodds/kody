import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { searchUnified } from '#mcp/capabilities/unified-search.ts'
import {
	listAppSecretsByAppIds,
	listUserSecretsForSearch,
} from '#mcp/secrets/service.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { listMcpSkillsByUserId } from '#mcp/skills/mcp-skills-repo.ts'
import { slugifySkillCollectionName } from '#mcp/skills/skill-collections.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { listUiArtifactsByUserId } from '#mcp/ui-artifacts-repo.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	getHomeConnectorStatus,
	type HomeConnectorStatus,
} from '#worker/home/status.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from './tool-call-context.ts'

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
Search Kody **builtin capabilities**, your saved **skills** (meta domain), your saved **apps** (apps domain), and your reusable **user secret references** by natural language before calling \`execute\` or opening a UI.

Each match has **type** \`capability\`, \`skill\`, \`app\`, or \`secret\`. To run a saved skill, call \`meta_run_skill\` with the \`skill_id\` and optional \`params\`. If you need to inspect the code, call \`meta_get_skill\` and then pass its code to \`execute\`. To reopen a saved app, call \`open_generated_ui\` with the \`app_id\`. User-scoped secret references never include raw secret values; inspect secret metadata during execution with \`codemode.secret_list(...)\`, and use generated UI when the user needs to provide a missing secret. App-bound secrets are attached to their corresponding app results rather than returned as standalone secret hits.

If search results seem incomplete, call \`meta_list_capabilities\` to inspect the exact current runtime capability registry (including dynamic capabilities such as connected home tools), or call \`meta_get_home_connector_status\` to confirm whether the home connector is connected.

 Domains (for context only—put hints in your \`query\` string, or use the skill collection filter when you already know the saved-skill grouping):
- \`coding\`: Software work such as GitHub repository actions, issues, pull requests, Cursor Cloud Agents API calls, Cloudflare API calls, and related docs/coding workflows.
- \`meta\`: Persisted and reusable codemode skills plus skill management.
- \`home\`: Home automation capabilities discovered from the connected home connector when available.

Pass a **query** string describing what you want to do. Results are ranked with semantic (Vectorize) and lexical fusion. **Skills** require an authenticated MCP user.

 Optional **limit** (default 15) caps how many results are returned. **detail: true** includes extra metadata (for skills: inferred capabilities, collection slug, etc.; for capabilities: JSON schemas where applicable). Optional **skill_collection** narrows saved skill results to one normalized collection/domain slug while still searching builtins, apps, and secrets normally.

 Optional **conversationId** groups related calls across the same client
conversation. Clients should generate and reuse one when possible; Kody returns
one in \`structuredContent.conversationId\` when omitted. Optional
\`memory_context\` accepts short, structured task context for future
memory-aware behavior.

Example arguments:
- \`{ "query": "saved interactive dashboard app", "limit": 10 }\`
- \`{ "query": "github automation", "skill_collection": "release-engineering" }\`
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
	userSecretRows: Array<SecretSearchRow>
	warnings: Array<string>
}

function shouldIncludeHomeConnectorStatus(status: HomeConnectorStatus) {
	return status.state !== 'connected' || status.toolCount === 0
}

export async function loadDownHomeConnectorStatus(input: {
	env: Env
	homeConnectorId: string | null
}): Promise<HomeConnectorStatus | null> {
	const status = await getHomeConnectorStatus(input.env, input.homeConnectorId)
	if (!shouldIncludeHomeConnectorStatus(status)) {
		return null
	}
	return status
}

export async function loadOptionalSearchRows(input: {
	userId: string | null
	loadSkills: () => Promise<Array<McpSkillRow>>
	loadUiArtifacts: () => Promise<Array<UiArtifactRow>>
	loadUserSecrets: () => Promise<Array<SecretSearchRow>>
}): Promise<OptionalSearchRowsResult> {
	if (!input.userId) {
		return {
			skillRows: [],
			uiArtifactRows: [],
			userSecretRows: [],
			warnings: [],
		}
	}

	const warnings: Array<string> = []
	let skillRows: Array<McpSkillRow> = []
	let uiArtifactRows: Array<UiArtifactRow> = []
	let userSecretRows: Array<SecretSearchRow> = []

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

	try {
		userSecretRows = await input.loadUserSecrets()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warnings.push(`User secrets are temporarily unavailable: ${message}`)
	}

	return {
		skillRows,
		uiArtifactRows,
		userSecretRows,
		warnings,
	}
}

export async function registerSearchTool(agent: McpRegistrationAgent) {
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
				skill_collection: z
					.string()
					.optional()
					.describe(
						'Optional saved-skill collection/domain name or slug to narrow skill matches to one grouping.',
					),
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
				conversationId: conversationIdInputField,
				memory_context: memoryContextInputField,
			},
			annotations: searchTool.annotations,
		},
		async (args: {
			query: string
			skill_collection?: string
			limit?: number
			detail?: boolean
			conversationId?: string
			memory_context?: z.infer<typeof memoryContextInputField>
		}) => {
			const startedAt = performance.now()
			const conversationId = resolveConversationId(args.conversationId)
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const userId = callerContext.user?.userId ?? null
			let warnings: Array<string> = []
			let homeConnectorStatus: HomeConnectorStatus | null = null

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
					loadUserSecrets: () =>
						listUserSecretsForSearch({
							env: agent.getEnv(),
							userId: userId!,
						}),
				})
				homeConnectorStatus = await loadDownHomeConnectorStatus({
					env: agent.getEnv(),
					homeConnectorId: callerContext.homeConnectorId ?? null,
				})
				warnings = optionalRows.warnings
				const appSecretsByAppId = userId
					? await listAppSecretsByAppIds({
							env: agent.getEnv(),
							userId,
							appIds: optionalRows.uiArtifactRows.map((row) => row.id),
						})
					: new Map()
				const skillCollectionSlug =
					args.skill_collection?.trim()
						? slugifySkillCollectionName(args.skill_collection)
						: undefined
				return searchUnified({
					env: agent.getEnv(),
					query: args.query,
					skillCollectionSlug,
					limit: args.limit ?? defaultSearchLimit,
					detail: args.detail === true,
					specs: registry.capabilitySpecs,
					userId,
					skillRows: optionalRows.skillRows,
					uiArtifactRows: optionalRows.uiArtifactRows,
					userSecretRows: optionalRows.userSecretRows,
					appSecretsByAppId,
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
						conversationId,
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
				...(homeConnectorStatus
					? {
							homeConnectorStatus,
						}
					: {}),
			}

			return {
				content: [
					{
						type: 'text',
						text: truncateSearchResult(payload),
					},
				],
				structuredContent: {
					conversationId,
					result: payload,
				},
			}
		},
	)
}
