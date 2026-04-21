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
	buildCapabilityEmbedText,
	blendLexicalAndVectorScore,
	cosineSimilarity,
	deterministicEmbedding,
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
import {
	type SearchIntent,
	type SearchableEntityDescriptor,
	extractSearchTokens,
	normalizeSearchText,
	understandSearchQuery,
} from './understand-search-query.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken
const defaultSearchLimit = 15
const defaultMaxResponseSize = 4_000

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

export type SearchScoreComponents = {
	base: number
	lexical: number
	vector: number
	entityMatch: number
	actionMatch: number
	taskAffinity: number
	appAvailability: number
	constraint: number
	final: number
}

type SearchCandidate = {
	match: SearchMatch
	type: SearchMatch['type']
	id: string
	title: string
	searchFields: Array<string>
	scoreComponents: SearchScoreComponents
}

export type SearchTelemetry = {
	intent: {
		task: SearchIntent['task']['name']
		confidence: number
		entityCount: number
		actionCount: number
		constraintCount: number
		topEntities: Array<{
			type: string
			id: string
			confidence: number
		}>
	}
	candidateCounts: Partial<Record<SearchMatch['type'], number>>
	topResultTypes: Array<SearchMatch['type']>
	trimmedMatchCount?: number
	responseTrimmed?: boolean
}

type SearchPhaseTimings = {
	queryUnderstandingMs: number
	candidateGenerationMs: number
	rerankingMs: number
	formattingMs?: number
}

type SearchUnifiedResult = {
	matches: Array<SearchMatch>
	offline: boolean
	intent: SearchIntent
	telemetry: SearchTelemetry
	phaseTimings: SearchPhaseTimings
}

function buildSearchableEntityDescriptors(input: {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
}): Array<SearchableEntityDescriptor> {
	const descriptors: Array<SearchableEntityDescriptor> = []

	for (const spec of Object.values(input.registry.capabilitySpecs)) {
		descriptors.push({
			type: 'capability',
			id: spec.name,
			title: spec.name,
			primaryAliases: [spec.name],
			secondaryAliases: [
				spec.domain,
				spec.description,
				...(spec.keywords ?? []),
			],
			tertiaryAliases: [
				...(spec.inputFields ?? []),
				...(spec.outputFields ?? []),
			],
		})
	}

	for (const entry of input.optionalRows.packageRows) {
		descriptors.push({
			type: 'package',
			id: entry.record.kodyId,
			title: entry.record.name,
			primaryAliases: [entry.record.kodyId, entry.record.name],
			secondaryAliases: [
				entry.record.description,
				entry.record.searchText ?? '',
				...entry.record.tags,
			],
			tertiaryAliases: [
				...entry.projection.exports,
				...entry.projection.jobs.map((job) => job.name),
				...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
			],
		})
	}

	for (const row of input.optionalRows.userValueRows) {
		const connectorName = parseConnectorValueName(row.name)
		if (connectorName) {
			const config = parseConnectorConfig(
				parseConnectorJson(row.value),
				connectorName,
			)
			if (!config) continue
			descriptors.push({
				type: 'connector',
				id: connectorName,
				title: connectorName,
				primaryAliases: [connectorName],
				secondaryAliases: [
					row.description,
					config.apiBaseUrl ?? '',
					config.tokenUrl,
					config.flow,
				],
				tertiaryAliases: config.requiredHosts ?? [],
			})
			continue
		}

		descriptors.push({
			type: 'value',
			id: buildValueEntityId(row),
			title: row.name,
			primaryAliases: [row.name],
			secondaryAliases: [row.description, row.scope],
			tertiaryAliases: [row.value],
		})
	}

	for (const row of input.optionalRows.userSecretRows) {
		descriptors.push({
			type: 'secret',
			id: row.name,
			title: row.name,
			primaryAliases: [row.name],
			secondaryAliases: [row.description],
		})
	}

	return descriptors
}

function buildCandidateTelemetry(input: {
	intent: SearchIntent
	candidates: Array<SearchCandidate>
	matches: Array<SearchMatch>
	trimmedMatchCount?: number
}): SearchTelemetry {
	const candidateCounts = input.candidates.reduce(
		(counts, candidate) => {
			counts[candidate.type] = (counts[candidate.type] ?? 0) + 1
			return counts
		},
		{} as Partial<Record<SearchMatch['type'], number>>,
	)

	return {
		intent: {
			task: input.intent.task.name,
			confidence: input.intent.confidence,
			entityCount: input.intent.entities.length,
			actionCount: input.intent.actions.length,
			constraintCount: input.intent.constraints.length,
			topEntities: input.intent.entities.slice(0, 3).map((entity) => ({
				type: entity.type,
				id: entity.id,
				confidence: entity.confidence,
			})),
		},
		candidateCounts,
		topResultTypes: input.matches.slice(0, 5).map((match) => match.type),
		...(input.trimmedMatchCount !== undefined
			? {
					trimmedMatchCount: input.trimmedMatchCount,
					responseTrimmed: input.trimmedMatchCount > 0,
				}
			: {}),
	}
}

function buildCandidateBaseScore(input: {
	lexical: number
	vector?: number
}): SearchScoreComponents {
	const vector = input.vector ?? 0
	return {
		base:
			input.vector === undefined
				? input.lexical
				: blendLexicalAndVectorScore(input.lexical, vector),
		lexical: input.lexical,
		vector,
		entityMatch: 0,
		actionMatch: 0,
		taskAffinity: 0,
		appAvailability: 0,
		constraint: 0,
		final:
			input.vector === undefined
				? input.lexical
				: blendLexicalAndVectorScore(input.lexical, vector),
	}
}

function scoreMatchedTerms(
	fields: ReadonlyArray<string>,
	matchedTerms: ReadonlyArray<string>,
): number {
	if (matchedTerms.length === 0 || fields.length === 0) return 0
	const fieldTokens = new Set<string>()
	for (const field of fields) {
		for (const token of extractSearchTokens(field)) {
			fieldTokens.add(token)
		}
	}
	let matched = 0
	for (const term of matchedTerms) {
		if (fieldTokens.has(term)) matched += 1
	}
	return matched / Math.max(1, matchedTerms.length)
}

function scoreConstraintBoost(
	fields: ReadonlyArray<string>,
	intent: SearchIntent,
): number {
	if (intent.constraints.length === 0) return 0
	const normalizedFields = fields.map((field) => normalizeSearchText(field))
	let score = 0
	for (const constraint of intent.constraints) {
		if (
			normalizedFields.some((field) =>
				field.includes(normalizeSearchText(constraint.value)),
			)
		) {
			score += 0.08
		}
	}
	return score
}

function scoreTaskAffinity(
	candidate: SearchCandidate,
	intent: SearchIntent,
): Pick<
	SearchScoreComponents,
	'taskAffinity' | 'actionMatch' | 'appAvailability' | 'constraint'
> {
	const taskConfidenceWeight = Math.min(
		1,
		Math.max(0.2, intent.task.confidence),
	)
	const matchedActionTerms = intent.actions.flatMap(
		(action) => action.matchedTerms,
	)
	const actionMatch =
		scoreMatchedTerms(candidate.searchFields, matchedActionTerms) *
		0.25 *
		taskConfidenceWeight
	const constraint =
		scoreConstraintBoost(candidate.searchFields, intent) * taskConfidenceWeight

	let taskAffinity = 0
	let appAvailability = 0

	switch (intent.task.name) {
		case 'operate':
			if (candidate.type === 'package') {
				taskAffinity += 0.16
				if ('hasApp' in candidate.match && candidate.match.hasApp) {
					appAvailability += 0.12
				}
			}
			if (candidate.type === 'connector') taskAffinity += 0.08
			if (candidate.type === 'capability') taskAffinity -= 0.04
			break
		case 'setup':
			if (candidate.type === 'connector') taskAffinity += 0.18
			if (candidate.type === 'value') taskAffinity += 0.06
			if (candidate.type === 'capability') taskAffinity += 0.05
			break
		case 'inspect':
			if (candidate.type === 'value' || candidate.type === 'connector') {
				taskAffinity += 0.12
			}
			if (candidate.type === 'package') taskAffinity += 0.05
			break
		case 'learn':
			if (candidate.type === 'capability') taskAffinity += 0.16
			if (candidate.type === 'package') taskAffinity -= 0.02
			break
		case 'debug':
			if (candidate.type === 'connector') taskAffinity += 0.16
			if (candidate.type === 'capability') taskAffinity += 0.06
			if (candidate.type === 'value') taskAffinity += 0.04
			break
		case 'unknown':
			break
	}

	return {
		taskAffinity: taskAffinity * taskConfidenceWeight,
		actionMatch,
		appAvailability,
		constraint,
	}
}

function rerankCandidates(input: {
	candidates: Array<SearchCandidate>
	intent: SearchIntent
	limit: number
}): Array<SearchCandidate> {
	const entityConfidenceByKey = new Map<string, number>(
		input.intent.entities.map((entity) => [
			`${entity.type}:${entity.id}`,
			entity.confidence,
		]),
	)
	const rerankWeight = Math.min(1, Math.max(0.25, input.intent.confidence))

	const reranked = input.candidates.map((candidate) => {
		const entityMatch =
			(entityConfidenceByKey.get(`${candidate.type}:${candidate.id}`) ?? 0) *
			0.45 *
			rerankWeight
		const taskSignals = scoreTaskAffinity(candidate, input.intent)
		const final =
			candidate.scoreComponents.base +
			entityMatch +
			taskSignals.actionMatch +
			taskSignals.taskAffinity +
			taskSignals.appAvailability +
			taskSignals.constraint

		return {
			...candidate,
			scoreComponents: {
				...candidate.scoreComponents,
				entityMatch,
				actionMatch: taskSignals.actionMatch,
				taskAffinity: taskSignals.taskAffinity,
				appAvailability: taskSignals.appAvailability,
				constraint: taskSignals.constraint,
				final,
			},
		}
	})

	return reranked
		.filter((candidate) => candidate.scoreComponents.final > 0)
		.sort((left, right) => {
			if (right.scoreComponents.final !== left.scoreComponents.final) {
				return right.scoreComponents.final - left.scoreComponents.final
			}
			return left.title.localeCompare(right.title)
		})
		.slice(0, input.limit)
}

function buildCapabilityCandidates(input: {
	query: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	queryEmbedding: ReadonlyArray<number>
}): Array<SearchCandidate> {
	return Object.values(input.registry.capabilitySpecs)
		.map((spec) => {
			const document = buildCapabilityEmbedText(spec)
			const lexical = lexicalScore(input.query, document)
			const vector = cosineSimilarity(
				input.queryEmbedding,
				deterministicEmbedding(document),
			)
			return {
				match: {
					type: 'capability' as const,
					name: spec.name,
					description: spec.description,
				},
				type: 'capability' as const,
				id: spec.name,
				title: spec.name,
				searchFields: [
					spec.name,
					spec.domain,
					spec.description,
					...(spec.keywords ?? []),
					...(spec.inputFields ?? []),
					...(spec.outputFields ?? []),
				],
				scoreComponents: buildCandidateBaseScore({
					lexical,
					vector,
				}),
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

function buildPackageCandidates(input: {
	query: string
	rows: Array<PackageSearchRow>
	queryEmbedding: ReadonlyArray<number>
}): Array<SearchCandidate> {
	return input.rows
		.map((entry) => {
			const tags = Array.isArray(entry.projection.tags)
				? entry.projection.tags
				: []
			const exports = Array.isArray(entry.projection.exports)
				? entry.projection.exports
				: []
			const jobs = Array.isArray(entry.projection.jobs)
				? entry.projection.jobs
				: []
			const document = [
				entry.projection.kodyId,
				entry.projection.name,
				entry.projection.description,
				tags.join(' '),
				entry.projection.searchText ?? '',
				exports.join(' '),
				jobs.map((job) => job.name).join(' '),
			].join('\n')
			const lexical = lexicalScore(input.query, document)
			const vector = cosineSimilarity(
				input.queryEmbedding,
				deterministicEmbedding(document),
			)
			return {
				match: {
					type: 'package' as const,
					packageId: entry.record.id,
					kodyId: entry.record.kodyId,
					name: entry.record.name,
					title: entry.record.name,
					description: entry.record.description,
					tags: entry.record.tags,
					hasApp: entry.record.hasApp,
				},
				type: 'package' as const,
				id: entry.record.kodyId,
				title: entry.record.name,
				searchFields: [
					entry.record.kodyId,
					entry.record.name,
					entry.record.description,
					entry.record.searchText ?? '',
					...entry.record.tags,
					...exports,
					...jobs.map((job) => job.name),
					...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
				],
				scoreComponents: buildCandidateBaseScore({
					lexical,
					vector,
				}),
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

function buildValueCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
}): Array<SearchCandidate> {
	return input.rows
		.flatMap((row) => {
			if (parseConnectorValueName(row.name)) return []
			const lexical = lexicalScore(
				input.query,
				[row.name, row.description, row.scope, row.value].join('\n'),
			)
			return [
				{
					match: {
						type: 'value' as const,
						valueId: buildValueEntityId(row),
						name: row.name,
						description: describeValue(row),
						scope: row.scope,
						appId: row.appId,
					},
					type: 'value' as const,
					id: buildValueEntityId(row),
					title: row.name,
					searchFields: [row.name, row.description, row.scope, row.value],
					scoreComponents: buildCandidateBaseScore({
						lexical,
					}),
				} satisfies SearchCandidate,
			]
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

function buildConnectorCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
}): Array<SearchCandidate> {
	return input.rows
		.flatMap((row) => {
			const connectorName = parseConnectorValueName(row.name)
			if (!connectorName) return []
			const config = parseConnectorConfig(
				parseConnectorJson(row.value),
				connectorName,
			)
			if (!config) return []
			const lexical = lexicalScore(
				input.query,
				[
					connectorName,
					row.description,
					config.tokenUrl,
					config.apiBaseUrl ?? '',
					config.flow,
					...(config.requiredHosts ?? []),
				].join('\n'),
			)
			return [
				{
					match: {
						type: 'connector' as const,
						connectorName,
						title: connectorName,
						description:
							row.description.trim() ||
							`Saved OAuth connector configuration (${config.flow} flow).`,
						flow: config.flow,
						apiBaseUrl: config.apiBaseUrl ?? null,
						requiredHosts: config.requiredHosts ?? [],
					},
					type: 'connector' as const,
					id: connectorName,
					title: connectorName,
					searchFields: [
						connectorName,
						row.description,
						config.flow,
						config.apiBaseUrl ?? '',
						config.tokenUrl,
						...(config.requiredHosts ?? []),
					],
					scoreComponents: buildCandidateBaseScore({
						lexical,
					}),
				} satisfies SearchCandidate,
			]
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

function buildSecretCandidates(input: {
	query: string
	rows: Array<SecretSearchRow>
}): Array<SearchCandidate> {
	return input.rows
		.map((row) => {
			const lexical = lexicalScore(
				input.query,
				`${row.name}\n${row.description}`,
			)
			return {
				match: {
					type: 'secret' as const,
					name: row.name,
					description: row.description,
				},
				type: 'secret' as const,
				id: row.name,
				title: row.name,
				searchFields: [row.name, row.description],
				scoreComponents: buildCandidateBaseScore({
					lexical,
				}),
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
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
}): SearchUnifiedResult {
	const offline = isCapabilitySearchOffline(input.env)
	const query = input.query.trim()
	const emptyIntent = understandSearchQuery({
		query,
		entities: [],
	})
	if (!query) {
		return {
			matches: [],
			offline,
			intent: emptyIntent,
			telemetry: buildCandidateTelemetry({
				intent: emptyIntent,
				candidates: [],
				matches: [],
			}),
			phaseTimings: {
				queryUnderstandingMs: 0,
				candidateGenerationMs: 0,
				rerankingMs: 0,
			},
		}
	}

	const limit = Math.max(1, input.limit)
	const queryUnderstandingStart = performance.now()
	const entityDescriptors = buildSearchableEntityDescriptors({
		registry: input.registry,
		optionalRows: input.optionalRows,
	})
	const intent = understandSearchQuery({
		query,
		entities: entityDescriptors,
	})
	const queryUnderstandingMs = Math.max(
		0,
		Math.round(performance.now() - queryUnderstandingStart),
	)
	const candidateGenerationStart = performance.now()
	const queryEmbedding = deterministicEmbedding(intent.normalizedQuery)
	const candidates = [
		...buildCapabilityCandidates({
			query: intent.normalizedQuery,
			registry: input.registry,
			queryEmbedding,
		}),
		...buildPackageCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.packageRows,
			queryEmbedding,
		}),
		...buildValueCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.userValueRows,
		}),
		...buildConnectorCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.userValueRows,
		}),
		...buildSecretCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.userSecretRows,
		}),
	]
	const candidateGenerationMs = Math.max(
		0,
		Math.round(performance.now() - candidateGenerationStart),
	)
	const rerankingStart = performance.now()
	const reranked = rerankCandidates({
		candidates,
		intent,
		limit,
	})
	const matches = reranked.map((candidate) => candidate.match)
	const rerankingMs = Math.max(
		0,
		Math.round(performance.now() - rerankingStart),
	)

	return {
		matches,
		offline,
		intent,
		telemetry: buildCandidateTelemetry({
			intent,
			candidates,
			matches,
		}),
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs,
			rerankingMs,
		},
	}
}

export async function searchPackages(input: {
	env: Env
	baseUrl: string
	query: string
	limit: number
	rows: Array<PackageSearchRow>
}): Promise<{ matches: Array<SearchMatch>; offline: boolean }> {
	const result = searchUnified({
		env: input.env,
		query: input.query,
		limit: input.limit,
		registry: {
			capabilitySpecs: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
		optionalRows: {
			packageRows: input.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})
	return {
		matches: result.matches,
		offline: result.offline,
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
				logMcpEvent({
					category: 'mcp',
					tool: 'search',
					toolName: 'search',
					outcome: 'failure',
					durationMs: timing.durationMs,
					baseUrl,
					hasUser,
					sandboxError: false,
					errorName: 'ValidationError',
					errorMessage: 'Provide either "query" or "entity".',
					message: 'Search request missing both query and entity.',
					context: {
						failurePhase: 'validation_error',
					},
				})
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
							result: SearchUnifiedResult
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
				const trimmedMatchCount = Math.max(
					0,
					outcome.result.matches.length - trimmedPayload.matches.length,
				)
				const result: SearchResultStructuredContent = {
					offline: trimmedPayload.offline,
					warnings: trimmedPayload.warnings,
					telemetry: buildCandidateTelemetry({
						intent: outcome.result.intent,
						candidates: [],
						matches: trimmedPayload.matches,
						trimmedMatchCount,
					}),
					phaseTimings: {
						...outcome.result.phaseTimings,
						formattingMs: 0,
					},
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
					message: 'Search completed successfully.',
					context: {
						task: outcome.result.intent.task.name,
						intentConfidence: outcome.result.intent.confidence,
						entityCount: outcome.result.intent.entities.length,
						actionCount: outcome.result.intent.actions.length,
						constraintCount: outcome.result.intent.constraints.length,
						candidateCounts: outcome.result.telemetry.candidateCounts,
						topResultTypes: result.telemetry?.topResultTypes ?? [],
						responseTrimmed: result.telemetry?.responseTrimmed ?? false,
						trimmedMatchCount,
						offline: outcome.result.offline,
						warningsCount: warnings.length,
						phaseTimings: result.phaseTimings,
					},
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
