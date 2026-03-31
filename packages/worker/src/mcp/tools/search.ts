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
import {
	getMcpSkillByName,
	listMcpSkillsByUserId,
} from '#mcp/skills/mcp-skills-repo.ts'
import { slugifySkillCollectionName } from '#mcp/skills/skill-collections.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import {
	getUiArtifactById,
	listUiArtifactsByUserId,
} from '#mcp/ui-artifacts-repo.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	getHomeConnectorStatus,
	type HomeConnectorStatus,
} from '#worker/home/status.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
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
import {
	type SearchResultStructuredContent,
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	parseEntityRef,
	toSlimStructuredMatches,
} from './search-format.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken
const defaultSearchLimit = 15
const defaultMaxResponseSize = 4_000

function truncateSearchText(text: string): string {
	if (text.length <= maxChars) return text

	return `${text.slice(0, maxChars)}\n\n--- TRUNCATED ---\nResponse was ~${Math.ceil(
		text.length / charsPerToken,
	).toLocaleString()} tokens (limit: ${maxTokens.toLocaleString()}). Lower the limit, maxResponseSize, or ask a shorter query.`
}

function applyMaxResponseSize<TPayload>(
	payload: TPayload,
	maxResponseSize: number,
	format: (payload: TPayload) => string,
	trim: (payload: TPayload, count: number) => TPayload,
	getCount: (payload: TPayload) => number,
): { payload: TPayload; serialized: string } {
	if (!Number.isFinite(maxResponseSize) || maxResponseSize <= 0) {
		const serialized = format(payload)
		return { payload, serialized }
	}

	const total = getCount(payload)
	let low = 0
	let high = total
	let bestPayload = trim(payload, 0)
	let bestSerialized = format(bestPayload)

	while (low <= high) {
		const mid = Math.floor((low + high) / 2)
		const trimmedPayload = trim(payload, mid)
		const serialized = format(trimmedPayload)
		if (serialized.length <= maxResponseSize) {
			bestPayload = trimmedPayload
			bestSerialized = serialized
			low = mid + 1
		} else {
			high = mid - 1
		}
	}

	return { payload: bestPayload, serialized: bestSerialized }
}

const searchTool = {
	name: 'search',
	title: 'Search Capabilities, Skills, Apps, and Secrets',
	description: `
Search Kody **builtin capabilities**, your saved **skills** (meta domain), your saved **apps** (apps domain), and your reusable **user secret references** by natural language before calling \`execute\` or opening a UI.

Search returns compact **markdown** plus slim structured results. Use \`query\` for ranked search, or use \`entity\` with an exact reference like \`page_to_markdown:capability\` or \`github-pr-summary:skill\` to get focused markdown detail for a single result.

Each match has **type** \`capability\`, \`skill\`, \`app\`, or \`secret\`. Saved skills are identified by a unique lower-kebab-case **name**. To run a saved skill, call \`meta_run_skill\` with the \`name\` and optional \`params\`. If you need to inspect the code, call \`meta_get_skill\`. To reopen a saved app, call \`open_generated_ui\` with the \`app_id\` or share its hosted URL with the user. User-scoped secret references never include raw secret values; inspect secret metadata during execution with \`codemode.secret_list(...)\`, and use generated UI when the user needs to provide a missing secret. App-bound secrets are attached to their corresponding app results rather than returned as standalone secret hits.

If search results seem incomplete, call \`meta_list_capabilities\` to inspect the exact current runtime capability registry (including dynamic capabilities such as connected home tools), or call \`meta_get_home_connector_status\` to confirm whether the home connector is connected.

 Domains (for context only—put hints in your \`query\` string, or use the skill collection filter when you already know the saved-skill grouping):
- \`coding\`: Billed page-to-markdown fallback, generated UI guides, and related coding workflows (Cloudflare API access is via saved skills; see repo docs).
- \`meta\`: Persisted and reusable codemode skills plus skill management.
- \`home\`: Home automation capabilities discovered from the connected home connector when available.

Pass a **query** string describing what you want to do. Results are ranked with semantic (Vectorize) and lexical fusion. **Skills** require an authenticated MCP user.

	Optional **limit** caps how many ranked results are returned (defaults to 15). Optional **maxResponseSize** trims low-ranked results to keep responses small. Optional **skill_collection** narrows saved skill results to one normalized collection/domain slug while still searching builtins, apps, and secrets normally.

Example arguments:
- \`{ "query": "saved interactive dashboard app", "limit": 10 }\`
- \`{ "query": "github automation", "skill_collection": "release-engineering" }\`
- \`{ "entity": "page_to_markdown:capability" }\`
- To run a skill: \`meta_run_skill({ "name": "github-pr-summary", "params": { "owner": "kentcdodds" } })\`
- To reopen a saved app: \`open_generated_ui({ "app_id": "<id>" })\`
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

type OptionalSearchRowsResult = {
	skillRows: Array<McpSkillRow>
	uiArtifactRows: Array<UiArtifactRow>
	userSecretRows: Array<SecretSearchRow>
	warnings: Array<string>
}

type SearchRowsAndRegistry = OptionalSearchRowsResult & {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	appSecretsByAppId: Awaited<ReturnType<typeof listAppSecretsByAppIds>>
}

function shouldIncludeHomeConnectorStatus(status: HomeConnectorStatus) {
	return status.state !== 'connected' || status.toolCount === 0
}

function serializeHomeConnectorStatus(status: HomeConnectorStatus | null):
	| {
			connectorId: string
			state: string
			connected: boolean
			toolCount: number
	  }
	| undefined {
	if (!status) return undefined
	return {
		connectorId: status.connectorId ?? 'unknown',
		state: status.state,
		connected: status.connected,
		toolCount: status.toolCount,
	}
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

async function loadSearchRowsAndRegistry(input: {
	agent: McpRegistrationAgent
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	userId: string | null
	skillCollection?: string
}) {
	const registry = await getCapabilityRegistryForContext({
		env: input.agent.getEnv(),
		callerContext: input.callerContext,
	})
	const optionalRows = await loadOptionalSearchRows({
		userId: input.userId,
		loadSkills: () =>
			listMcpSkillsByUserId(input.agent.getEnv().APP_DB, input.userId!),
		loadUiArtifacts: () =>
			listUiArtifactsByUserId(input.agent.getEnv().APP_DB, input.userId!, {
				hidden: false,
			}),
		loadUserSecrets: () =>
			listUserSecretsForSearch({
				env: input.agent.getEnv(),
				userId: input.userId!,
			}),
	})
	const appSecretsByAppId = input.userId
		? await listAppSecretsByAppIds({
				env: input.agent.getEnv(),
				userId: input.userId,
				appIds: optionalRows.uiArtifactRows.map((row) => row.id),
			})
		: new Map()
	const skillCollectionSlug = input.skillCollection?.trim()
		? slugifySkillCollectionName(input.skillCollection)
		: undefined
	return {
		registry,
		skillCollectionSlug,
		appSecretsByAppId,
		...optionalRows,
	}
}

async function resolveEntityDetail(input: {
	agent: McpRegistrationAgent
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	userId: string | null
	entity: string
	searchRows: SearchRowsAndRegistry
}) {
	const ref = parseEntityRef(input.entity)
	if (ref.type === 'capability') {
		const spec = input.searchRows.registry.capabilitySpecs[ref.id]
		if (!spec) {
			throw new Error('Capability not found.')
		}
		return {
			type: 'capability' as const,
			id: ref.id,
			title: spec.name,
			description: spec.description,
			spec,
		}
	}

	if (!input.userId) {
		throw new Error('Authentication required to access saved user entities.')
	}

	if (ref.type === 'skill') {
		const row = await getMcpSkillByName(
			input.agent.getEnv().APP_DB,
			input.userId,
			ref.id,
		)
		if (!row) {
			throw new Error('Skill not found for this user.')
		}
		return {
			type: 'skill' as const,
			id: row.name,
			title: row.title,
			description: row.description,
			row,
		}
	}

	if (ref.type === 'app') {
		const row = await getUiArtifactById(
			input.agent.getEnv().APP_DB,
			input.userId,
			ref.id,
		)
		if (!row || row.hidden) {
			throw new Error('Saved app not found for this user.')
		}
		return {
			type: 'app' as const,
			id: row.id,
			title: row.title,
			description: row.description,
			row,
			hostedUrl: buildSavedUiUrl(input.callerContext.baseUrl, row.id),
		}
	}

	const row = input.searchRows.userSecretRows.find(
		(secret) => secret.name === ref.id,
	)
	if (!row) {
		throw new Error('Secret not found for this user.')
	}
	return {
		type: 'secret' as const,
		id: row.name,
		title: row.name,
		description: row.description,
		row,
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
					.optional()
					.describe('Natural language description of the capability you need.'),
				entity: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Optional exact entity reference in the format "{id}:{type}" where type is capability, skill, app, or secret.',
					),
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
			},
			annotations: searchTool.annotations,
		},
		async (args: {
			query?: string
			entity?: string
			skill_collection?: string
			limit?: number
			maxResponseSize?: number
			conversationId?: string
			memoryContext?: z.infer<typeof memoryContextInputField>
		}) => {
			const startedAt = performance.now()
			const conversationId = resolveConversationId(args.conversationId)
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const userId = callerContext.user?.userId ?? null
			if (!args.query && !args.entity) {
				return {
					content: prependToolMetadataContent(conversationId, [
						{
							type: 'text',
							text: 'Error: Provide either "query" or "entity".',
						},
					]),
					structuredContent: {
						conversationId,
						error: 'Provide either "query" or "entity".',
					},
					isError: true,
				}
			}
			const limit = args.limit ?? defaultSearchLimit
			const maxResponseSize = args.maxResponseSize ?? defaultMaxResponseSize
			let warnings: Array<string> = []
			let homeConnectorStatus: HomeConnectorStatus | null = null

			const searchSpan = async () => {
				const searchRows = await loadSearchRowsAndRegistry({
					agent,
					callerContext,
					userId,
					skillCollection: args.skill_collection,
				})
				homeConnectorStatus = await loadDownHomeConnectorStatus({
					env: agent.getEnv(),
					homeConnectorId: callerContext.homeConnectorId ?? null,
				})
				warnings = searchRows.warnings

				if (args.entity) {
					return {
						mode: 'entity' as const,
						detail: await resolveEntityDetail({
							agent,
							callerContext,
							userId,
							entity: args.entity,
							searchRows: {
								registry: searchRows.registry,
								skillRows: searchRows.skillRows,
								uiArtifactRows: searchRows.uiArtifactRows,
								userSecretRows: searchRows.userSecretRows,
								warnings: searchRows.warnings,
								appSecretsByAppId: searchRows.appSecretsByAppId,
							},
						}),
					}
				}

				return {
					mode: 'list' as const,
					result: await searchUnified({
						baseUrl,
						env: agent.getEnv(),
						query: args.query!,
						skillCollectionSlug: searchRows.skillCollectionSlug,
						limit,
						specs: searchRows.registry.capabilitySpecs,
						userId,
						skillRows: searchRows.skillRows,
						uiArtifactRows: searchRows.uiArtifactRows,
						userSecretRows: searchRows.userSecretRows,
						appSecretsByAppId: searchRows.appSecretsByAppId,
					}),
				}
			}

			let outcome:
				| {
						mode: 'list'
						result: Awaited<ReturnType<typeof searchUnified>>
				  }
				| {
						mode: 'entity'
						detail: Awaited<ReturnType<typeof resolveEntityDetail>>
				  }
			try {
				outcome = await Sentry.startSpan(
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
					content: prependToolMetadataContent(conversationId, [
						{ type: 'text', text: `Error: ${error.message}` },
					]),
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

			if (outcome.mode === 'entity') {
				const entityResult = formatEntityDetailMarkdown(outcome.detail)
				return {
					content: prependToolMetadataContent(conversationId, [
						{
							type: 'text',
							text: truncateSearchText(entityResult.markdown),
						},
					]),
					structuredContent: {
						conversationId,
						result: entityResult.structured,
					},
				}
			}

			const normalizedHomeConnectorStatus =
				serializeHomeConnectorStatus(homeConnectorStatus)

			const payload: {
				matches: Awaited<ReturnType<typeof searchUnified>>['matches']
				offline: boolean
				warnings: Array<string>
				homeConnectorStatus?: {
					connectorId: string
					state: string
					connected: boolean
					toolCount: number
				}
			} = {
				matches: outcome.result.matches,
				offline: outcome.result.offline,
				warnings,
				...(normalizedHomeConnectorStatus
					? {
							homeConnectorStatus: normalizedHomeConnectorStatus,
						}
					: {}),
			}
			const statefulAgent = agent as McpRegistrationAgent & {
				state?: {
					searchConversationIdsWithPreamble?: Array<string>
				}
				setState?: (state: {
					searchConversationIdsWithPreamble?: Array<string>
				}) => void
			}
			const searchConversationIdsWithPreamble = Array.isArray(
				statefulAgent.state?.searchConversationIdsWithPreamble,
			)
				? (statefulAgent.state?.searchConversationIdsWithPreamble ?? [])
				: []
			const includePreamble =
				!args.conversationId ||
				!searchConversationIdsWithPreamble.includes(conversationId)
			if (includePreamble && typeof statefulAgent.setState === 'function') {
				statefulAgent.setState({
					...(statefulAgent.state ?? {}),
					searchConversationIdsWithPreamble: [
						...searchConversationIdsWithPreamble,
						conversationId,
					],
				})
			}
			const { payload: trimmedPayload, serialized } = applyMaxResponseSize(
				payload,
				maxResponseSize,
				(value) =>
					formatSearchMarkdown({
						matches: value.matches,
						warnings: value.warnings,
						baseUrl,
						includePreamble,
					}),
				(value, count) => ({
					...value,
					matches: value.matches.slice(0, count),
				}),
				(value) => value.matches.length,
			)
			const result: SearchResultStructuredContent = {
				offline: trimmedPayload.offline,
				warnings: trimmedPayload.warnings,
				...(trimmedPayload.homeConnectorStatus
					? { homeConnectorStatus: trimmedPayload.homeConnectorStatus }
					: {}),
				matches: toSlimStructuredMatches({
					matches: trimmedPayload.matches,
					baseUrl,
				}),
			}

			return {
				content: prependToolMetadataContent(conversationId, [
					{
						type: 'text',
						text: truncateSearchText(serialized),
					},
				]),
				structuredContent: {
					conversationId,
					result,
				},
			}
		},
	)
}
