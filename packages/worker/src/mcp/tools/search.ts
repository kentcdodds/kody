import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	parseConnectorConfig,
	parseConnectorJson,
	parseConnectorValueName,
} from '#mcp/capabilities/values/connector-shared.ts'
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
import { loadRelevantMemoriesForTool } from '#mcp/tools/memory-tool-context.ts'
import {
	buildValueEntityId,
	parseValueEntityId,
} from '#mcp/tools/search-entities.ts'
import { listValues } from '#mcp/values/service.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
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
	title: 'Search Capabilities, Values, Connectors, Skills, Apps, and Secrets',
	description: `
Find **builtin capabilities**, **persisted values**, **saved connectors**,
**saved skills**, **saved apps**, and **user secret references** (metadata only)
before \`execute\` or \`open_generated_ui\`.

**query** — ranked markdown + structured matches (order matters). If nothing useful
returns, rephrase or call \`meta_list_capabilities\`; \`entity\` does not fix an
empty ranked list.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`value\`
| \`connector\` | \`skill\` | \`app\` | \`secret\`), including schemas for
capabilities. Types and fields: see response.

Skills need a signed-in user. Run a skill: \`meta_run_skill({ name, params })\`;
source: \`meta_get_skill\`. Apps: \`open_generated_ui({ app_id })\`. Secrets: never
raw in results; use \`codemode.secret_list\` during execute and UI for missing values.
Persisted values use \`codemode.value_get\` / \`codemode.value_list\`. Connectors
use \`codemode.connector_get\` / \`codemode.connector_list\`.

If results look incomplete: \`meta_list_capabilities\` (full registry) or
\`meta_get_home_connector_status\` (home connector). Searchable values and
connectors come from the signed-in user's persisted config.

Domain hints for \`query\` / \`skill_collection\`: \`coding\`, \`meta\`, \`home\`
(see server instructions).

Optional **limit** (default 15), **maxResponseSize**, **skill_collection** (narrow
skills only).

Example arguments:
- \`{ "query": "saved interactive dashboard app", "limit": 10 }\`
- \`{ "query": "preferred org value or saved connector", "limit": 10 }\`
- \`{ "query": "github automation", "skill_collection": "release-engineering" }\`
- \`{ "entity": "page_to_markdown:capability" }\`
- \`{ "entity": "user:preferred_org:value" }\`
- \`{ "entity": "github:connector" }\`
- To run a skill: \`meta_run_skill({ "name": "github-pr-summary", "params": { "owner": "kentcdodds" } })\`
- To reopen a saved app: \`open_generated_ui({ "app_id": "<id>" })\`

https://github.com/kentcdodds/kody/blob/main/docs/use/search.md
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
	userValueRows: Array<ValueMetadata>
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
	loadUserValues: () => Promise<Array<ValueMetadata>>
}): Promise<OptionalSearchRowsResult> {
	if (!input.userId) {
		return {
			skillRows: [],
			uiArtifactRows: [],
			userSecretRows: [],
			userValueRows: [],
			warnings: [],
		}
	}

	const warnings: Array<string> = []
	let skillRows: Array<McpSkillRow> = []
	let uiArtifactRows: Array<UiArtifactRow> = []
	let userSecretRows: Array<SecretSearchRow> = []
	let userValueRows: Array<ValueMetadata> = []

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

	try {
		userValueRows = await input.loadUserValues()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warnings.push(`Persisted values are temporarily unavailable: ${message}`)
	}

	return {
		skillRows,
		uiArtifactRows,
		userSecretRows,
		userValueRows,
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
		loadUserValues: () =>
			listValues({
				env: input.agent.getEnv(),
				userId: input.userId!,
				storageContext: {
					sessionId: input.callerContext.storageContext?.sessionId ?? null,
					appId: input.callerContext.storageContext?.appId ?? null,
				},
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

function describeValue(row: ValueMetadata): string {
	const description = row.description.trim()
	if (description) return description
	if (row.scope === 'app' && row.appId) {
		return `Persisted app-scoped value for app ${row.appId}.`
	}
	return `Persisted ${row.scope}-scoped value.`
}

function findConnectorDetail(
	rows: Array<ValueMetadata>,
	connectorName: string,
) {
	for (const row of rows) {
		if (parseConnectorValueName(row.name) !== connectorName) continue
		const config = parseConnectorConfig(
			parseConnectorJson(row.value),
			connectorName,
		)
		if (!config) continue
		return { row, config }
	}
	return null
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

	if (ref.type === 'value') {
		const valueRef = parseValueEntityId(ref.id)
		const row = input.searchRows.userValueRows.find(
			(value) => value.scope === valueRef.scope && value.name === valueRef.name,
		)
		if (!row) {
			throw new Error('Persisted value not found for this user.')
		}
		return {
			type: 'value' as const,
			id: buildValueEntityId(row),
			title: row.name,
			description: describeValue(row),
			row,
		}
	}

	if (ref.type === 'connector') {
		const connector = findConnectorDetail(
			input.searchRows.userValueRows,
			ref.id,
		)
		if (!connector) {
			throw new Error('Saved connector not found for this user.')
		}
		return {
			type: 'connector' as const,
			id: connector.config.name,
			title: connector.config.name,
			description:
				connector.row.description.trim() ||
				`Saved OAuth connector configuration (${connector.config.flow} flow).`,
			row: connector.row,
			config: connector.config,
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
						'Optional exact entity reference in the format "{id}:{type}" where type is capability, skill, app, secret, value, or connector.',
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
								userValueRows: searchRows.userValueRows,
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
						userValueRows: searchRows.userValueRows,
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
			const memoryToolContext = await loadRelevantMemoriesForTool({
				env: agent.getEnv(),
				callerContext,
				conversationId,
				memoryContext: args.memoryContext,
			})
			const searchMemories = memoryToolContext
				? {
						surfaced: memoryToolContext.memories,
						suppressedCount: memoryToolContext.suppressedCount,
						retrievalQuery: memoryToolContext.retrievalQuery,
					}
				: undefined

			const payload: {
				matches: Awaited<ReturnType<typeof searchUnified>>['matches']
				offline: boolean
				warnings: Array<string>
				memories?: SearchResultStructuredContent['memories']
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
				...(searchMemories
					? {
							memories: searchMemories,
						}
					: {}),
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
						memories: value.memories,
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
				...(trimmedPayload.memories
					? {
							memories: trimmedPayload.memories,
						}
					: {}),
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
