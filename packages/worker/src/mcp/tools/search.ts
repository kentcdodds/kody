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
	cosineSimilarity,
	deterministicEmbedding,
	hybridSearchScore,
	isCapabilitySearchOffline,
	lexicalScore,
} from '#mcp/capabilities/capability-search.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
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
import { type buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
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
	type SearchMatch,
	type SearchResultStructuredContent,
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	parseEntityRef,
	toSlimStructuredMatches,
} from './search-format.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken
const defaultSearchLimit = 15
const defaultMaxResponseSize = 4_000
const searchTokenPattern = /[a-z0-9]+/g
const operationalQueryStopwords = new Set([
	'a',
	'an',
	'and',
	'app',
	'apps',
	'automation',
	'automations',
	'by',
	'channel',
	'channels',
	'computer',
	'connector',
	'connectors',
	'create',
	'created',
	'creating',
	'data',
	'delete',
	'desktop',
	'doc',
	'docs',
	'document',
	'documents',
	'email',
	'emails',
	'event',
	'events',
	'file',
	'files',
	'find',
	'for',
	'from',
	'get',
	'in',
	'inbox',
	'into',
	'job',
	'jobs',
	'laptop',
	'list',
	'mail',
	'messages',
	'message',
	'me',
	'music',
	'my',
	'note',
	'notes',
	'oauth',
	'of',
	'on',
	'open',
	'or',
	'package',
	'packages',
	'phone',
	'play',
	'playlist',
	'playlists',
	'post',
	'run',
	'saved',
	'search',
	'send',
	'song',
	'songs',
	'start',
	'stop',
	'task',
	'tasks',
	'team',
	'the',
	'time',
	'to',
	'tool',
	'tools',
	'update',
	'use',
	'user',
	'via',
	'with',
	'workflow',
	'workflows',
	'your',
])

export type PackageSearchRow = {
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]
	projection: ReturnType<typeof buildPackageSearchProjection>
}

export type OptionalSearchRowsResult = {
	packageRows: Array<PackageSearchRow>
	userSecretRows: Array<SecretSearchRow>
	userValueRows: Array<ValueMetadata>
	warnings: Array<string>
}

function normalizeSearchText(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
}

function extractSearchTokens(text: string): Array<string> {
	return normalizeSearchText(text).match(searchTokenPattern) ?? []
}

function extractMeaningfulQueryTokens(query: string): Array<string> {
	const meaningfulTokens: Array<string> = []
	const seenTokens = new Set<string>()
	for (const token of extractSearchTokens(query)) {
		if (token.length < 3) continue
		if (operationalQueryStopwords.has(token)) continue
		if (seenTokens.has(token)) continue
		seenTokens.add(token)
		meaningfulTokens.push(token)
	}
	return meaningfulTokens
}

function scoreExactTokenCoverage(
	queryTokens: ReadonlyArray<string>,
	fields: ReadonlyArray<string | null | undefined>,
): number {
	if (queryTokens.length === 0) return 0
	const fieldTokens = new Set<string>()
	for (const field of fields) {
		if (!field) continue
		for (const token of extractSearchTokens(field)) {
			fieldTokens.add(token)
		}
	}
	if (fieldTokens.size === 0) return 0
	let matches = 0
	for (const token of queryTokens) {
		if (fieldTokens.has(token)) matches += 1
	}
	return matches / queryTokens.length
}

function hasPrimaryPhraseMatch(
	query: string,
	fields: ReadonlyArray<string | null | undefined>,
): boolean {
	const normalizedQuery = extractSearchTokens(query).join(' ')
	if (!normalizedQuery) return false
	for (const field of fields) {
		if (!field) continue
		const normalizedField = extractSearchTokens(field).join(' ')
		if (!normalizedField.includes(' ')) continue
		if (normalizedQuery.includes(normalizedField)) return true
	}
	return false
}

function scoreOperationalIdentityBoost(input: {
	query: string
	primaryFields: ReadonlyArray<string | null | undefined>
	secondaryFields?: ReadonlyArray<string | null | undefined>
	tertiaryFields?: ReadonlyArray<string | null | undefined>
}): number {
	const meaningfulQueryTokens = extractMeaningfulQueryTokens(input.query)
	if (meaningfulQueryTokens.length === 0) return 0
	const primaryCoverage = scoreExactTokenCoverage(
		meaningfulQueryTokens,
		input.primaryFields,
	)
	const secondaryCoverage = scoreExactTokenCoverage(
		meaningfulQueryTokens,
		input.secondaryFields ?? [],
	)
	const tertiaryCoverage = scoreExactTokenCoverage(
		meaningfulQueryTokens,
		input.tertiaryFields ?? [],
	)
	return (
		primaryCoverage * 0.85 +
		secondaryCoverage * 0.35 +
		tertiaryCoverage * 0.2 +
		(hasPrimaryPhraseMatch(input.query, input.primaryFields) ? 0.2 : 0)
	)
}

export function searchUnified(input: {
	env: Env
	query: string
	limit: number
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
}): { matches: Array<SearchMatch>; offline: boolean } {
	const offline = isCapabilitySearchOffline(input.env)
	const query = input.query.trim()
	if (!query) {
		return {
			matches: [],
			offline,
		}
	}

	const limit = Math.max(1, input.limit)
	const queryEmbedding = deterministicEmbedding(query)
	const capabilityMatches = Object.values(input.registry.capabilitySpecs)
		.map((spec) => ({
			type: 'capability' as const,
			name: spec.name,
			description: spec.description,
			score: lexicalScore(query, `${spec.name}\n${spec.description}`),
		}))
		.filter((match) => match.score > 0)
	const packageMatches = input.optionalRows.packageRows
		.map((entry) => {
			const doc = [
				entry.projection.name,
				entry.projection.kodyId,
				entry.projection.description,
				entry.projection.tags.join(' '),
				entry.projection.searchText ?? '',
				entry.projection.exports.join(' '),
				entry.projection.jobs.map((job) => job.name).join(' '),
			].join('\n')
			const lexical = lexicalScore(query, doc)
			const vector = cosineSimilarity(
				queryEmbedding,
				deterministicEmbedding(doc),
			)
			const identityBoost = scoreOperationalIdentityBoost({
				query,
				primaryFields: [entry.record.kodyId, entry.record.name],
				secondaryFields: entry.record.tags,
				tertiaryFields: [
					...entry.projection.exports,
					...entry.projection.jobs.map((job) => job.name),
				],
			})
			return {
				type: 'package' as const,
				packageId: entry.record.id,
				kodyId: entry.record.kodyId,
				name: entry.record.name,
				title: entry.record.name,
				description: entry.record.description,
				tags: entry.record.tags,
				hasApp: entry.record.hasApp,
				score: hybridSearchScore(lexical, vector) + identityBoost,
			}
		})
		.filter((match) => match.score > 0)
	const valueMatches = input.optionalRows.userValueRows
		.flatMap((row) => {
			if (parseConnectorValueName(row.name)) return []
			return [
				{
					type: 'value' as const,
					valueId: buildValueEntityId(row),
					name: row.name,
					description: describeValue(row),
					scope: row.scope,
					appId: row.appId,
					score: lexicalScore(
						query,
						[row.name, row.description, row.scope, row.value].join('\n'),
					),
				},
			]
		})
		.filter((match) => match.score > 0)
	const connectorMatches = input.optionalRows.userValueRows
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
					score:
						lexicalScore(
							query,
							[
								connectorName,
								row.description,
								config.tokenUrl,
								config.apiBaseUrl ?? '',
							].join('\n'),
						) +
						scoreOperationalIdentityBoost({
							query,
							primaryFields: [connectorName],
							secondaryFields: config.requiredHosts ?? [],
						}),
				},
			]
		})
		.filter((match) => match.score > 0)
	const secretMatches = input.optionalRows.userSecretRows
		.map((row) => ({
			type: 'secret' as const,
			name: row.name,
			description: row.description,
			score: lexicalScore(query, `${row.name}\n${row.description}`),
		}))
		.filter((match) => match.score > 0)

	return {
		matches: [
			...capabilityMatches,
			...packageMatches,
			...valueMatches,
			...connectorMatches,
			...secretMatches,
		]
			.sort((left, right) => right.score - left.score)
			.slice(0, limit)
			.map(({ score: _score, ...match }) => match),
		offline,
	}
}

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
			const vector = cosineSimilarity(
				queryEmbedding,
				deterministicEmbedding(document),
			)
			const identityBoost = scoreOperationalIdentityBoost({
				query,
				primaryFields: [row.record.kodyId, row.record.name],
				secondaryFields: row.projection.tags,
				tertiaryFields: [
					...row.projection.exports,
					...row.projection.jobs.map((job) => job.name),
				],
			})
			return {
				row,
				score: lexical + vector + identityBoost,
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
	title: 'Search Capabilities, Packages, Values, Connectors, and Secrets',
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
	const [packageRowsResult, userSecretRowsResult, userValueRowsResult] =
		await Promise.allSettled([
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
						'Optional exact entity reference in the format "{id}:{type}" where type is capability, package, secret, value, or connector.',
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
			const timingStart = startToolTiming()
			const conversationId = resolveConversationId(args.conversationId)
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const userId = callerContext.user?.userId ?? null
			if (!args.query && !args.entity) {
				const timing = finishToolTiming(timingStart)
				return {
					content: prependToolMetadataContent(conversationId, [
						{
							type: 'text',
							text: 'Error: Provide either "query" or "entity".',
						},
					]),
					structuredContent: {
						conversationId,
						timing,
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

				const result = searchUnified({
					env: agent.getEnv(),
					query: args.query!,
					limit,
					registry: searchRows.registry,
					optionalRows: searchRows,
				})

				return {
					mode: 'list' as const,
					result,
				}
			}

			try {
				const outcome:
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
					  } = await Sentry.startSpan(
					{
						name: 'mcp.tool.search',
						op: 'mcp.tool',
						attributes: {
							'mcp.tool': 'search',
						},
					},
					searchSpan,
				)

				if (outcome.mode === 'entity') {
					const entityResult = formatEntityDetailMarkdown(outcome.detail)
					const timing = finishToolTiming(timingStart)
					logMcpEvent({
						category: 'mcp',
						tool: 'search',
						toolName: 'search',
						outcome: 'success',
						durationMs: timing.durationMs,
						baseUrl,
						hasUser,
					})
					return {
						content: prependToolMetadataContent(conversationId, [
							{
								type: 'text',
								text: truncateSearchText(entityResult.markdown),
							},
						]),
						structuredContent: {
							conversationId,
							timing,
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
				const timing = finishToolTiming(timingStart)
				logMcpEvent({
					category: 'mcp',
					tool: 'search',
					toolName: 'search',
					outcome: 'success',
					durationMs: timing.durationMs,
					baseUrl,
					hasUser,
				})
				return {
					content: prependToolMetadataContent(conversationId, [
						{
							type: 'text',
							text: truncateSearchText(serialized),
						},
					]),
					structuredContent: {
						conversationId,
						timing,
						result,
					},
				}
			} catch (cause) {
				const timing = finishToolTiming(timingStart)
				const error = cause instanceof Error ? cause : new Error(String(cause))
				const { errorName, errorMessage } = errorFields(error)
				logMcpEvent({
					category: 'mcp',
					tool: 'search',
					toolName: 'search',
					outcome: 'failure',
					durationMs: timing.durationMs,
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
						timing,
						error: error.message,
					},
					isError: true,
				}
			}
		},
	)
}
