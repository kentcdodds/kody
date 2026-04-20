import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	parseConnectorConfig,
	parseConnectorJson,
	parseConnectorValueName,
} from '#mcp/capabilities/values/connector-shared.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	deterministicEmbedding,
	lexicalScore,
	cosineSimilarity,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import {
	listUserSecretsForSearch,
} from '#mcp/secrets/service.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { loadRelevantMemoriesForTool } from '#mcp/tools/memory-tool-context.ts'
import {
	buildValueEntityId,
	describeValue,
	parseValueEntityId,
} from '#mcp/tools/search-entities.ts'
import { listValues } from '#mcp/values/service.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import {
	getSavedPackageByKodyId,
	listSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
import {
	getRemoteConnectorStatus,
	type HomeConnectorStatus,
} from '#worker/home/status.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
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

type PackageSearchRow = {
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]
	projection: ReturnType<typeof buildPackageSearchProjection>
}

type SearchMatch =
	Parameters<typeof toSlimStructuredMatches>[0]['matches'][number]

export async function searchPackages(input: {
	env: Env
	baseUrl: string
	query: string
	limit: number
	rows: Array<PackageSearchRow>
}): Promise<{ matches: Array<SearchMatch>; offline: boolean }> {
	const query = input.query.trim()
	const offline = isCapabilitySearchOffline(input.env)
	if (!query || input.rows.length === 0) {
		return { matches: [], offline }
	}
	const queryEmbedding = deterministicEmbedding(query)
	const ranked = input.rows
		.map((row) => {
			const document = [
				row.projection.kodyId,
				row.projection.name,
				row.projection.description,
				row.projection.tags.join(' '),
				row.projection.searchText ?? '',
				row.projection.exports.join(' '),
				row.projection.jobs.map((job) => job.name).join(' '),
			].join('\n')
			const lexical = lexicalScore(query, document)
			const vector = cosineSimilarity(queryEmbedding, deterministicEmbedding(document))
			return {
				row,
				score: lexical + vector,
			}
		})
		.sort((left, right) => right.score - left.score)
		.slice(0, Math.max(1, Math.min(input.limit, input.rows.length)))
		.map(({ row }) => ({
			type: 'package' as const,
			packageId: row.record.id,
			kodyId: row.record.kodyId,
			name: row.record.name,
			title: row.record.name,
			description: row.record.description,
			tags: row.record.tags,
			hasApp: row.record.hasApp,
		}))
	return {
		matches: ranked,
		offline,
	}
}

export function resolveSearchMemoryContext(input: {
	query?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
}) {
	if (input.memoryContext !== undefined) {
		return input.memoryContext
	}

	const query = input.query?.trim() ?? ''
	return query.length > 0 ? { query } : undefined
}

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
	title:
		'Search Capabilities, Packages, Values, Connectors, and Secrets',
	description: `
Find **built-in capabilities**, **saved packages**, **persisted values**,
**saved connectors**, and **user secret references** (metadata only)
before \`execute\` or \`open_generated_ui\`.

**query** — ranked markdown + structured matches (order matters). If nothing useful
returns, rephrase or call \`meta_list_capabilities\`; \`entity\` does not fix an
empty ranked list.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`value\`
| \`connector\` | \`package\` | \`secret\`), including schemas for
capabilities. Types and fields: see response.

Packages: \`package_list\`, \`package_get\`, and \`repo_*\` for editing/publishing.
Open package apps with \`open_generated_ui({ package_id })\` or hosted package URLs.
Secrets: never raw in results; use
\`codemode.secret_list\` during execute and UI for missing values.
Persisted values use \`codemode.value_get\` / \`codemode.value_list\`. Connectors
use \`codemode.connector_get\` / \`codemode.connector_list\`.

If results look incomplete: \`meta_list_capabilities\` (full registry) or
\`meta_list_remote_connector_status\` / \`meta_get_home_connector_status\` (remote connectors).

Optional **limit** (default 15) and **maxResponseSize** trim low-ranked results.

Example arguments:
- \`{ "query": "saved github automation package", "limit": 10 }\`
- \`{ "query": "preferred org value or saved connector", "limit": 10 }\`
- \`{ "query": "package with worker app ui", "limit": 10 }\`
- \`{ "entity": "kody_official_guide:capability" }\`
- \`{ "entity": "user:preferred_org:value" }\`
- \`{ "entity": "github:connector" }\`
- To open a saved package app: \`open_generated_ui({ "package_id": "<id>" })\`

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
	packageRows: Array<PackageSearchRow>
	userSecretRows: Array<SecretSearchRow>
	userValueRows: Array<ValueMetadata>
	warnings: Array<string>
}

type SearchRowsAndRegistry = OptionalSearchRowsResult & {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}

function shouldIncludeRemoteConnectorStatus(status: HomeConnectorStatus) {
	return status.state !== 'connected' || status.toolCount === 0
}

function serializeRemoteConnectorStatus(status: HomeConnectorStatus): {
	connectorKind: string
	connectorId: string
	state: string
	connected: boolean
	toolCount: number
} {
	return {
		connectorKind: status.connectorKind,
		connectorId: status.connectorId ?? 'unknown',
		state: status.state,
		connected: status.connected,
		toolCount: status.toolCount,
	}
}

export async function loadDownRemoteConnectorStatuses(input: {
	env: Env
	callerContext: Pick<McpCallerContext, 'homeConnectorId' | 'remoteConnectors'>
}): Promise<Array<HomeConnectorStatus>> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const statuses = await Promise.all(
		refs.map((ref) => getRemoteConnectorStatus(input.env, ref)),
	)
	return statuses.filter(shouldIncludeRemoteConnectorStatus)
}

/** @deprecated Prefer loadDownRemoteConnectorStatuses with full caller context. */
export async function loadDownHomeConnectorStatus(input: {
	env: Env
	homeConnectorId: string | null
}): Promise<HomeConnectorStatus | null> {
	const statuses = await loadDownRemoteConnectorStatuses({
		env: input.env,
		callerContext: {
			homeConnectorId: input.homeConnectorId,
			remoteConnectors: null,
		},
	})
	return statuses[0] ?? null
}

export async function loadOptionalSearchRows(input: {
	userId: string | null
	loadPackages: () => Promise<Array<PackageSearchRow>>
	loadUserSecrets: () => Promise<Array<SecretSearchRow>>
	loadUserValues: () => Promise<Array<ValueMetadata>>
}): Promise<OptionalSearchRowsResult> {
	if (!input.userId) {
		return {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
			warnings: [],
		}
	}

	const warnings: Array<string> = []
	const [
		packageRowsResult,
		userSecretRowsResult,
		userValueRowsResult,
	] = await Promise.allSettled([
		input.loadPackages(),
		input.loadUserSecrets(),
		input.loadUserValues(),
	])

	const packageRows =
		packageRowsResult.status === 'fulfilled' ? packageRowsResult.value : []
	if (packageRowsResult.status === 'rejected') {
		const message =
			packageRowsResult.reason instanceof Error
				? packageRowsResult.reason.message
				: String(packageRowsResult.reason)
		warnings.push(`Saved packages are temporarily unavailable: ${message}`)
	}

	const userSecretRows =
		userSecretRowsResult.status === 'fulfilled'
			? userSecretRowsResult.value
			: []
	if (userSecretRowsResult.status === 'rejected') {
		const message =
			userSecretRowsResult.reason instanceof Error
				? userSecretRowsResult.reason.message
				: String(userSecretRowsResult.reason)
		warnings.push(`User secrets are temporarily unavailable: ${message}`)
	}

	const userValueRows =
		userValueRowsResult.status === 'fulfilled' ? userValueRowsResult.value : []
	if (userValueRowsResult.status === 'rejected') {
		const message =
			userValueRowsResult.reason instanceof Error
				? userValueRowsResult.reason.message
				: String(userValueRowsResult.reason)
		warnings.push(`Persisted values are temporarily unavailable: ${message}`)
	}

	return {
		packageRows,
		userSecretRows,
		userValueRows,
		warnings,
	}
}

async function loadSearchRowsAndRegistry(input: {
	agent: McpRegistrationAgent
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	userId: string | null
}) {
	const [registry, optionalRows] = await Promise.all([
		getCapabilityRegistryForContext({
			env: input.agent.getEnv(),
			callerContext: input.callerContext,
		}),
		loadOptionalSearchRows({
			userId: input.userId,
			loadPackages: async () => {
				const savedPackages = await listSavedPackagesByUserId(
					input.agent.getEnv().APP_DB,
					{
						userId: input.userId!,
					},
				)
				return savedPackages.map((record) => ({
					record,
					projection: {
						name: record.name,
						kodyId: record.kodyId,
						description: record.description,
						tags: record.tags,
						searchText: record.searchText,
						hasApp: record.hasApp,
						exports: [],
						jobs: [],
					},
				}))
			},
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
		}),
	])
	return {
		registry,
		...optionalRows,
	}
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

	if (ref.type === 'package') {
		const record = await getSavedPackageByKodyId(input.agent.getEnv().APP_DB, {
			userId: input.userId,
			kodyId: ref.id,
		})
		if (!record) {
			throw new Error('Saved package not found for this user.')
		}
		const loaded = await loadPackageSourceBySourceId({
			env: input.agent.getEnv(),
			baseUrl: input.callerContext.baseUrl,
			userId: input.userId,
			sourceId: record.sourceId,
		})
		return {
			type: 'package' as const,
			id: record.kodyId,
			title: record.name,
			description: record.description,
			record,
			manifest: loaded.manifest,
			files: loaded.files,
			hostedUrl: record.hasApp
				? `${input.callerContext.baseUrl}/packages/${encodeURIComponent(record.kodyId)}`
				: null,
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
						'Optional exact entity reference in the format "{id}:{type}" where type is capability, skill, app, job, secret, value, or connector.',
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
			let remoteConnectorDownStatuses: Array<HomeConnectorStatus> = []

			const searchSpan = async () => {
				const searchRows = await loadSearchRowsAndRegistry({
					agent,
					callerContext,
					userId,
				})
				remoteConnectorDownStatuses = await loadDownRemoteConnectorStatuses({
					env: agent.getEnv(),
					callerContext,
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
						searchRows,
						}),
					}
				}

				const capabilityMatches = Object.values(
					searchRows.registry.capabilitySpecs,
				)
					.map((spec) => ({
						type: 'capability' as const,
						name: spec.name,
						description: spec.description,
						score: lexicalScore(args.query!, `${spec.name}\n${spec.description}`),
					}))
					.filter((match) => match.score > 0)
				const packageMatches = searchRows.packageRows
					.map((entry) => {
						const doc = [
							entry.record.name,
							entry.record.kodyId,
							entry.record.description,
							entry.record.tags.join(' '),
							entry.record.searchText ?? '',
						].join('\n')
						const lexical = lexicalScore(args.query!, doc)
						const vector = cosineSimilarity(
							deterministicEmbedding(args.query!),
							deterministicEmbedding(doc),
						)
						return {
							type: 'package' as const,
							packageId: entry.record.id,
							kodyId: entry.record.kodyId,
							name: entry.record.name,
							title: entry.record.name,
							description: entry.record.description,
							tags: entry.record.tags,
							hasApp: entry.record.hasApp,
							score:
								isCapabilitySearchOffline(agent.getEnv()) ? lexical + vector : lexical + vector,
						}
					})
					.filter((match) => match.score > 0)
				const valueMatches = searchRows.userValueRows
					.map((row) => ({
						type: 'value' as const,
						valueId: buildValueEntityId(row),
						name: row.name,
						description: describeValue(row),
						scope: row.scope,
						appId: row.appId,
						score: lexicalScore(
							args.query!,
							[row.name, row.description, row.scope, row.value].join('\n'),
						),
					}))
					.filter((match) => match.score > 0)
				const connectorMatches = searchRows.userValueRows
					.flatMap((row) => {
						const connectorName = parseConnectorValueName(row.name)
						if (!connectorName) return []
						const config = parseConnectorConfig(
							parseConnectorJson(row.value),
							connectorName,
						)
						if (!config) return []
						return [
							{
								type: 'connector' as const,
								connectorName,
								title: connectorName,
								description:
									row.description.trim() ||
									`Saved OAuth connector configuration (${config.flow} flow).`,
								flow: config.flow,
								apiBaseUrl: config.apiBaseUrl ?? null,
								requiredHosts: config.requiredHosts ?? [],
								score: lexicalScore(
									args.query!,
									[
										connectorName,
										row.description,
										config.tokenUrl,
										config.apiBaseUrl ?? '',
									].join('\n'),
								),
							},
						]
					})
					.filter((match) => match.score > 0)
				const secretMatches = searchRows.userSecretRows
					.map((row) => ({
						type: 'secret' as const,
						name: row.name,
						description: row.description,
						score: lexicalScore(args.query!, `${row.name}\n${row.description}`),
					}))
					.filter((match) => match.score > 0)
				const allMatches = [
					...capabilityMatches,
					...packageMatches,
					...valueMatches,
					...connectorMatches,
					...secretMatches,
				]
					.sort((left, right) => right.score - left.score)
					.slice(0, limit)
					.map(({ score: _score, ...match }) => match)

				return {
					mode: 'list' as const,
					result: {
						matches: allMatches,
						offline: isCapabilitySearchOffline(agent.getEnv()),
					},
				}
			}

			let outcome:
				| {
						mode: 'list'
				result: {
					matches: Array<SearchMatch>
					offline: boolean
				}
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

			const normalizedRemoteConnectorStatuses =
				remoteConnectorDownStatuses.length > 0
					? remoteConnectorDownStatuses.map(serializeRemoteConnectorStatus)
					: undefined
			const normalizedHomeConnectorStatus =
				remoteConnectorDownStatuses.length === 1 &&
				remoteConnectorDownStatuses[0]?.connectorKind === 'home'
					? serializeRemoteConnectorStatus(remoteConnectorDownStatuses[0]!)
					: undefined
			const memoryToolContext = await loadRelevantMemoriesForTool({
				env: agent.getEnv(),
				callerContext,
				conversationId,
				memoryContext: resolveSearchMemoryContext({
					query: args.query,
					memoryContext: args.memoryContext,
				}),
			})
			const searchMemories = memoryToolContext
				? {
						surfaced: memoryToolContext.memories,
						suppressedCount: memoryToolContext.suppressedCount,
						retrievalQuery: memoryToolContext.retrievalQuery,
					}
				: undefined

			const payload: {
				matches: Array<SearchMatch>
				offline: boolean
				warnings: Array<string>
				memories?: SearchResultStructuredContent['memories']
				homeConnectorStatus?: {
					connectorKind: string
					connectorId: string
					state: string
					connected: boolean
					toolCount: number
				}
				remoteConnectorStatuses?: Array<{
					connectorKind: string
					connectorId: string
					state: string
					connected: boolean
					toolCount: number
				}>
			} = {
				matches: outcome.result.matches,
				offline: outcome.result.offline,
				warnings,
				...(searchMemories
					? {
							memories: searchMemories,
						}
					: {}),
				...(normalizedRemoteConnectorStatuses
					? {
							remoteConnectorStatuses: normalizedRemoteConnectorStatuses,
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
				...(trimmedPayload.remoteConnectorStatuses
					? {
							remoteConnectorStatuses: trimmedPayload.remoteConnectorStatuses,
						}
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
