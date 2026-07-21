import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	parseIntegrationConfig,
	parseIntegrationJson,
	parseIntegrationValueName,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import {
	CAPABILITY_SEARCH_RRF_K,
	blendLexicalAndVectorScore,
	cosineSimilarity,
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
	lexicalScore,
	reciprocalRankFusion,
	searchCapabilities,
	sortIdsByScore,
} from '#mcp/capabilities/capability-search.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	acknowledgeToolMemories,
	buildMemoryRetrievalQuery,
	loadRelevantMemoriesForTool,
	type MemoryToolSummary,
} from '#mcp/tools/memory-tool-context.ts'
import {
	buildValueEntityId,
	describeValue,
	parseValueEntityId,
} from '#mcp/tools/search-entities.ts'
import { getValue, listValues } from '#mcp/values/service.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
	listSavedPackagesByUserId,
	savedPackageVectorId,
} from '#worker/package-registry/repo.ts'
import {
	buildPackageSearchDocument,
	buildPackageSearchProjection,
	type PackageSearchProjection,
} from '#worker/package-registry/manifest.ts'
import {
	buildPackageReadmeSnippet,
	type PackageReadmeSnippet,
} from '#worker/package-registry/package-readme.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	getRemoteConnectorStatus,
	type RemoteConnectorStatus,
} from '#worker/remote-connector/status.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'
import { resolvePublicUsername } from '#app/user-lookup.ts'
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
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import {
	type PackageActionMatch,
	type RelatedCapabilityOperation,
	type SearchEntityDetailStructured,
	type SearchMatch,
	type SearchResultStructuredContent,
	buildKodyCapabilityAccessor,
	buildPackageActionImportUsage,
	compactCapabilityInputTypeDefinition,
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	getPrimaryPackageActionFunction,
	parseEntityRef,
	toSlimStructuredMatches,
} from './search-format.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'
import {
	type SearchIntent,
	type SearchableEntityDescriptor,
	extractMeaningfulSearchTokens,
	extractSearchTokens,
	normalizeSearchText,
	understandSearchQuery,
} from './understand-search-query.ts'
import { resolvePackageIdentitySearch } from './package-search-identity.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken
const defaultSearchLimit = 15
const defaultMaxResponseSize = 4_000
const topCapabilityInlineCallShapeCount = 3
const maxRelatedCapabilityOperations = 20
const maxBatchEntityRefs = 10
const maxFusedPackageCandidates = 100
export const SEARCH_MEMORY_ENRICHMENT_BUDGET_MS = 1_000
/** Bound wait for post-retrieval D1 acknowledgement; does not cover retrieval. */
export const SEARCH_MEMORY_ACKNOWLEDGEMENT_BUDGET_MS = 250
export const memoryEnrichmentSkippedWarning =
	'Memory enrichment was skipped; returning core results without memory context.'
export const memoryAcknowledgementWarning =
	'Memory acknowledgement did not complete; surfaced memories may repeat in this conversation.'

export type PackageSearchRow = {
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]
	projection: PackageSearchProjection
	readmeSnippet?: PackageReadmeSnippet | null
	hydrate?: () => Promise<{
		projection: PackageSearchProjection
		readmeSnippet: PackageReadmeSnippet | null
	}>
}

export type OptionalSearchRowsResult = {
	packageRows: Array<PackageSearchRow>
	userSecretRows: Array<SecretSearchRow>
	userValueRows: Array<ValueMetadata>
	warnings: Array<string>
}

type LoadedPackageRows =
	| Array<PackageSearchRow>
	| BuildSavedPackageSearchRowsResult

export type SearchScoreComponents = {
	base: number
	lexical: number
	vector: number
	entityMatch: number
	providerEntityAffinity: number
	actionMatch: number
	taskAffinity: number
	appAvailability: number
	wrapperWorkflow: number
	constraint: number
	final: number
}

type SearchCandidate = {
	match: SearchMatch
	type: SearchMatch['type']
	id: string
	title: string
	searchFields: Array<string>
	identityFields?: Array<string>
	providerIdentityFields?: Array<string>
	synthesizedProviderKey?: string
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
	rowAndRegistryLoadMs?: number
	retrieversMs?: number
	queryEmbeddingMs?: number
	capabilityCandidatesMs?: number
	packageCandidatesMs?: number
	remoteConnectorStatusMs?: number
	memoryEnrichmentMs?: number
	memoryEnrichmentWaitMs?: number
	memoryAcknowledgementMs?: number
	memoryEnrichmentTimedOut?: boolean
	memoryAcknowledgementTimedOut?: boolean
	memoryEnrichmentFailed?: boolean
	memoryAcknowledgementFailed?: boolean
}

function elapsedMs(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt))
}

export async function settleWithBudget<T>(
	promise: Promise<T>,
	budgetMs: number,
	launchedAtMs: number = performance.now(),
): Promise<
	| { ok: true; value: T; durationMs: number; timedOut: false; failed: false }
	| {
			ok: false
			value: null
			durationMs: number
			timedOut: true
			failed: false
	  }
	| {
			ok: false
			value: null
			durationMs: number
			timedOut: false
			failed: true
			error: unknown
	  }
> {
	const remainingMs = Math.max(0, budgetMs - (performance.now() - launchedAtMs))
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const raced = await Promise.race([
			promise.then(
				(value) => ({ status: 'fulfilled' as const, value }) as const,
				(error: unknown) => ({ status: 'rejected' as const, error }) as const,
			),
			new Promise<{ status: 'timeout' }>((resolve) => {
				timeoutId = setTimeout(() => {
					resolve({ status: 'timeout' })
				}, remainingMs)
			}),
		])
		const durationMs = elapsedMs(launchedAtMs)
		if (raced.status === 'timeout') {
			return {
				ok: false,
				value: null,
				durationMs,
				timedOut: true,
				failed: false,
			}
		}
		if (raced.status === 'rejected') {
			return {
				ok: false,
				value: null,
				durationMs,
				timedOut: false,
				failed: true,
				error: raced.error,
			}
		}
		return {
			ok: true,
			value: raced.value,
			durationMs,
			timedOut: false,
			failed: false,
		}
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

type SearchGuidanceContext = {
	query: string
	intent: SearchIntent
	matches: Array<SearchMatch>
}

type SearchCapabilityMatch = Awaited<
	ReturnType<typeof searchCapabilities>
>['matches'][number]

type SearchUnifiedResult = {
	matches: Array<SearchMatch>
	offline: boolean
	intent: SearchIntent
	telemetry: SearchTelemetry
	phaseTimings: SearchPhaseTimings
	guidance?: string
}

function buildExactPackageSearchResult(input: {
	env: Env
	query: string
	match: Extract<SearchMatch, { type: 'package' }> | null
}): SearchUnifiedResult {
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({
		query: input.query,
		entities: [],
	})
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	const matches = input.match ? [input.match] : []
	const candidates: Array<SearchCandidate> = input.match
		? [
				{
					match: input.match,
					type: 'package',
					id: input.match.kodyId,
					title: input.match.title,
					searchFields: [input.match.kodyId, input.match.name],
					scoreComponents: buildCandidateBaseScore({
						lexical: 1,
						vector: 1,
					}),
				},
			]
		: []
	const guidance = buildRecommendedNextStep({
		query: input.query,
		intent,
		matches,
	})
	return {
		matches,
		offline: isCapabilitySearchOffline(input.env),
		intent,
		telemetry: buildCandidateTelemetry({
			intent,
			candidates,
			matches,
		}),
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs: 0,
			rerankingMs: 0,
		},
		...(guidance ? { guidance } : {}),
	}
}

function flattenReferencedTypeFields(
	referencedTypes:
		| ReadonlyArray<{ name: string; definition: string }>
		| undefined,
): Array<string> {
	return (referencedTypes ?? []).flatMap((referencedType) => [
		referencedType.name,
		referencedType.definition,
	])
}

export type BuildSavedPackageSearchRowsResult = {
	rows: Array<PackageSearchRow>
	warnings: Array<string>
}

function buildLeanPackageSearchProjection(
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number],
): PackageSearchProjection {
	return {
		name: record.name,
		kodyId: record.kodyId,
		description: record.description,
		tags: record.tags,
		searchText: record.searchText,
		hasApp: record.hasApp,
		isPrivate: record.isPrivate,
		appEntry: null,
		exports: [],
		jobs: [],
		services: [],
		subscriptions: [],
		retrievers: [],
	}
}

export async function buildSavedPackageSearchRows(input: {
	env: Env
	baseUrl: string
	userId: string
	records: Array<Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]>
}): Promise<BuildSavedPackageSearchRowsResult> {
	const rows = input.records.map((record) => {
		let hydration: Promise<{
			projection: PackageSearchProjection
			readmeSnippet: PackageReadmeSnippet | null
		}> | null = null
		return {
			record,
			projection: buildLeanPackageSearchProjection(record),
			readmeSnippet: null,
			hydrate: () => {
				hydration ??= loadPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: record.sourceId,
				}).then((loaded) => ({
					projection: buildPackageSearchProjection(
						loaded.manifest,
						loaded.files,
					),
					readmeSnippet: buildPackageReadmeSnippet({
						files: loaded.files,
						maxChars: 1_000,
					}),
				}))
				return hydration
			},
		} satisfies PackageSearchRow
	})
	return { rows, warnings: [] }
}

function buildPackageRelationTokens(
	match: Extract<SearchMatch, { type: 'package' }>,
) {
	return new Set(
		extractSearchTokens(
			[match.kodyId, match.name, match.description, match.tags.join(' ')].join(
				'\n',
			),
		),
	)
}

function buildIntegrationSearchDocument(input: {
	integrationName: string
	description: string
	config: NonNullable<ReturnType<typeof parseIntegrationConfig>>
}): string {
	return [
		input.integrationName,
		input.description,
		input.config.tokenUrl,
		input.config.apiBaseUrl ?? '',
		input.config.flow,
		input.config.authorization?.authorizeUrl ?? '',
		...(input.config.authorization?.scopes ?? []),
		...(input.config.requiredHosts ?? []),
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}

function buildRecommendedNextStep(
	input: SearchGuidanceContext,
): string | undefined {
	const [topMatch] = input.matches
	const topPackage = input.matches.find((match) => match.type === 'package')
	const topIntegration = input.matches.find(
		(match) => match.type === 'integration',
	)
	const packageRelationTokens = topPackage
		? buildPackageRelationTokens(topPackage)
		: null
	const integrationMatchesPackage =
		topPackage &&
		topIntegration &&
		(packageRelationTokens?.has(topIntegration.integrationName.toLowerCase()) ??
			false)

	if (integrationMatchesPackage && input.intent.task.name === 'operate') {
		return `Found saved package \`${topPackage.kodyId}\` and integration \`${topIntegration.integrationName}\`. Inspect the package with \`search({ entity: "${topPackage.kodyId}:package" })\`, then use the integration detail or an authenticated \`execute\` smoke test to confirm the integration path before running API-backed actions.`
	}
	if (topMatch?.type === 'package') {
		const [actionMatch] = topMatch.actionMatches ?? []
		const actionFunction = actionMatch
			? getPrimaryPackageActionFunction(actionMatch)
			: null
		if (actionMatch && actionFunction) {
			const importStatement = buildPackageActionImportUsage({
				packageName: topMatch.name,
				subpath: actionMatch.subpath,
				functionName: actionFunction.name,
			})
			return `Use \`${importStatement}\` for the matched package action. Inspect \`search({ entity: "${topMatch.kodyId}:package" })\` only if you need more exports or full package detail.`
		}
		return topMatch.hasApp
			? `Inspect package detail with \`search({ entity: "${topMatch.kodyId}:package" })\` to review exports, jobs, and the hosted app URL.`
			: `Inspect package detail with \`search({ entity: "${topMatch.kodyId}:package" })\` to review exports, then import the right entry from \`${buildPackageImportSpecifier(topMatch.name, '.')}\` or a subpath export.`
	}
	if (topMatch?.type === 'integration') {
		return `Inspect integration detail with \`search({ entity: "${topMatch.integrationName}:integration" })\` and then run a minimal authenticated \`execute\` smoke test before building or calling integration-backed code.`
	}
	if (topMatch?.type === 'capability') {
		const accessor = buildKodyCapabilityAccessor(topMatch)
		if (
			topMatch.inputTypeDefinition &&
			!topMatch.inputTypeDefinitionTruncated
		) {
			return `Call \`${accessor}(args)\` from \`execute\` using the inlined call shape above. Use \`search({ entity: "${topMatch.name}:capability" })\` only if you need the full type definitions.`
		}
		return `Inspect capability detail with \`search({ entity: "${topMatch.name}:capability" })\` to confirm the TypeScript call shape, then call it from \`execute\` via \`${accessor}(args)\`.`
	}
	return undefined
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
		const services = Array.isArray(entry.projection.services)
			? entry.projection.services
			: []
		const subscriptions = Array.isArray(entry.projection.subscriptions)
			? entry.projection.subscriptions
			: []
		const retrievers = Array.isArray(entry.projection.retrievers)
			? entry.projection.retrievers
			: []
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
				...entry.projection.exports.flatMap((exportDetail) => [
					exportDetail.subpath,
					exportDetail.description ?? '',
					exportDetail.typeDefinition ?? '',
					...flattenReferencedTypeFields(exportDetail.referencedTypes),
					...(exportDetail.functions ?? []).flatMap((fn) => [
						fn.name,
						fn.description ?? '',
						fn.typeDefinition ?? '',
						...flattenReferencedTypeFields(fn.referencedTypes),
					]),
				]),
				...entry.projection.jobs.map((job) => job.name),
				...services.flatMap((service) => [
					service.name,
					service.entry,
					service.mode,
					service.autoStart ? 'auto-start' : 'manual-start',
				]),
				...subscriptions.flatMap((subscription) => [
					subscription.topic,
					subscription.handler,
					subscription.description ?? '',
				]),
				...retrievers.flatMap((retriever) => [
					retriever.key,
					retriever.name,
					retriever.description,
				]),
				entry.readmeSnippet?.snippet ?? '',
				...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
			],
		})
	}

	for (const row of input.optionalRows.userValueRows) {
		const integrationName = parseIntegrationValueName(row.name)
		if (integrationName) {
			const config = parseIntegrationConfig(
				parseIntegrationJson(row.value),
				integrationName,
			)
			if (!config) continue
			descriptors.push({
				type: 'integration',
				id: integrationName,
				title: integrationName,
				primaryAliases: [integrationName],
				secondaryAliases: [
					row.description,
					config.apiBaseUrl ?? '',
					config.tokenUrl,
					config.flow,
				],
				tertiaryAliases: [
					...(config.requiredHosts ?? []),
					...(config.apiBaseUrl ? extractSearchTokens(config.apiBaseUrl) : []),
				],
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
		providerEntityAffinity: 0,
		actionMatch: 0,
		taskAffinity: 0,
		appAvailability: 0,
		wrapperWorkflow: 0,
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
		if (typeof field !== 'string') continue
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

function semanticSearchConcept(token: string): string {
	const normalized = normalizeSearchText(token)
	if (['speaker', 'speakers', 'player', 'players'].includes(normalized)) {
		return 'media-player'
	}
	if (
		[
			'playing',
			'paused',
			'running',
			'connected',
			'disconnected',
			'status',
			'statuses',
			'state',
			'states',
		].includes(normalized)
	) {
		return 'live-state'
	}
	if (normalized.endsWith('ies') && normalized.length > 3) {
		return `${normalized.slice(0, -3)}y`
	}
	if (
		normalized.endsWith('s') &&
		normalized.length > 3 &&
		!normalized.endsWith('ss')
	) {
		return normalized.slice(0, -1)
	}
	return normalized
}

function scoreSemanticMatchedTerms(
	fields: ReadonlyArray<string>,
	matchedTerms: ReadonlyArray<string>,
): number {
	if (matchedTerms.length === 0 || fields.length === 0) return 0
	const fieldConcepts = new Set(
		fields.flatMap((field) =>
			extractSearchTokens(field).map(semanticSearchConcept),
		),
	)
	const matched = matchedTerms.filter((term) =>
		fieldConcepts.has(semanticSearchConcept(term)),
	).length
	return matched / matchedTerms.length
}

const nonIdentityQueryTerms = new Set([
	'any',
	'are',
	'be',
	'do',
	'does',
	'is',
	'whether',
])

function getSearchIdentityTerms(intent: SearchIntent): Array<string> {
	const actionTerms = new Set(
		intent.actions.flatMap((action) => action.matchedTerms),
	)
	const constraintTerms = new Set(
		intent.constraints.map((constraint) => constraint.value),
	)
	return intent.meaningfulTokens.filter(
		(token) =>
			!actionTerms.has(token) &&
			!constraintTerms.has(token) &&
			!nonIdentityQueryTerms.has(token),
	)
}

function buildPackageExportSearchFields(
	exportDetail: PackageSearchProjection['exports'][number],
) {
	return [
		exportDetail.subpath,
		exportDetail.runtimeTarget ?? '',
		exportDetail.typesPath ?? '',
		exportDetail.description ?? '',
		exportDetail.typeDefinition ?? '',
		...flattenReferencedTypeFields(exportDetail.referencedTypes),
		...(exportDetail.functions ?? []).flatMap((fn) => [
			fn.name,
			fn.description ?? '',
			fn.typeDefinition ?? '',
			...flattenReferencedTypeFields(fn.referencedTypes),
		]),
	]
}

function buildPackageActionMatches(input: {
	query: string
	meaningfulTokens: ReadonlyArray<string>
	exports: ReadonlyArray<PackageSearchProjection['exports'][number]>
}): Array<PackageActionMatch> {
	if (input.meaningfulTokens.length === 0) return []
	return input.exports
		.map((exportDetail) => {
			const searchFields = buildPackageExportSearchFields(exportDetail)
			const matchedTerms = input.meaningfulTokens.filter((token) =>
				scoreMatchedTerms(searchFields, [token]),
			)
			const termCoverage =
				matchedTerms.length / Math.max(1, input.meaningfulTokens.length)
			const score =
				lexicalScore(input.query, searchFields.join('\n')) +
				Math.min(0.5, termCoverage * 0.65)
			return {
				subpath: exportDetail.subpath,
				description: exportDetail.description,
				typeDefinition: exportDetail.typeDefinition,
				functions: (exportDetail.functions ?? []).map((fn) => ({
					name: fn.name,
					description: fn.description,
					typeDefinition: fn.typeDefinition,
				})),
				score,
				matchedTerms,
			} satisfies PackageActionMatch
		})
		.filter(
			(match) =>
				match.functions.length > 0 &&
				(match.matchedTerms.length >= 2 || match.score >= 0.35),
		)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score
			return left.subpath.localeCompare(right.subpath)
		})
		.slice(0, 3)
}

function scoreConstraintBoost(
	fields: ReadonlyArray<string>,
	intent: SearchIntent,
): number {
	if (intent.constraints.length === 0) return 0
	const normalizedFields = fields
		.filter((field): field is string => typeof field === 'string')
		.map((field) => normalizeSearchText(field))
	let score = 0
	for (const constraint of intent.constraints) {
		if (
			normalizedFields.some((field) =>
				field.includes(normalizeSearchText(constraint.value)),
			) ||
			scoreSemanticMatchedTerms(fields, [constraint.value]) > 0
		) {
			score += 0.08
		}
	}
	return score
}

const wrapperWorkflowTokenSignals = new Set([
	'wrap',
	'wrapper',
	'wrappers',
	'wraps',
	'wrapping',
	'safe',
	'safer',
	'safety',
	'guardrail',
	'guardrails',
	'confirmation',
	'confirm',
	'confirmed',
	'workflow',
	'workflows',
	'orchestrate',
	'orchestrates',
	'orchestration',
	'automation',
	'automations',
	'helper',
	'helpers',
])

const wrapperWorkflowPhraseSignals = [
	'package first',
	'high level',
	'higher level',
	'safe wrapper',
	'workflow glue',
] as const

const packageSurfaceTokenSignals = new Set([
	'app',
	'ui',
	'service',
	'services',
	'workflow',
	'workflows',
	'subscription',
	'subscriptions',
	'retriever',
	'retrievers',
	'job',
	'jobs',
])

function scorePackageWrapperWorkflowBoost(
	candidate: SearchCandidate,
	intent: SearchIntent,
) {
	if (candidate.type !== 'package') return 0
	if (intent.meaningfulTokens.length === 0) return 0

	const fieldText = candidate.searchFields.join('\n')
	const fieldTokens = new Set(extractSearchTokens(fieldText))
	const normalizedFieldText = normalizeSearchText(fieldText)
	const matchedQueryTerms = intent.meaningfulTokens.filter((token) =>
		fieldTokens.has(token),
	)
	const queryCoverage =
		matchedQueryTerms.length / Math.max(1, intent.meaningfulTokens.length)
	const actionTermCount = intent.actions.flatMap(
		(action) => action.matchedTerms,
	).length
	const actionCoverage = scoreMatchedTerms(
		candidate.searchFields,
		intent.actions.flatMap((action) => action.matchedTerms),
	)

	const wrapperSignalCount = [...wrapperWorkflowTokenSignals].filter((token) =>
		fieldTokens.has(token),
	).length
	const wrapperPhraseCount = wrapperWorkflowPhraseSignals.filter((phrase) =>
		normalizedFieldText.includes(phrase),
	).length
	const surfaceSignalCount = [...packageSurfaceTokenSignals].filter((token) =>
		fieldTokens.has(token),
	).length
	const hasPackageSurface =
		surfaceSignalCount > 0 ||
		('hasApp' in candidate.match && candidate.match.hasApp)

	if (wrapperSignalCount + wrapperPhraseCount === 0 && !hasPackageSurface) {
		return 0
	}
	if (queryCoverage < 0.2 && (actionTermCount === 0 || actionCoverage <= 0)) {
		return 0
	}

	const taskWeight =
		intent.task.name === 'learn'
			? 0.25
			: intent.task.name === 'inspect' && isLiveStatusInspect(intent)
				? 0.15
				: intent.task.name === 'unknown'
					? 0.75
					: 1
	const confidenceWeight = Math.min(
		1,
		Math.max(0.35, intent.confidence, intent.task.confidence),
	)
	let boost = 0
	if (wrapperSignalCount > 0) boost += 0.14
	if (wrapperPhraseCount > 0) boost += 0.1
	if (hasPackageSurface) boost += 0.1
	if ('hasApp' in candidate.match && candidate.match.hasApp) boost += 0.04
	boost += Math.min(0.1, queryCoverage * 0.16)
	boost += Math.min(0.08, actionCoverage * 0.1)
	return Math.min(0.42, boost) * confidenceWeight * taskWeight
}

function isPackageOrientedInspect(intent: SearchIntent): boolean {
	return intent.meaningfulTokens.some((token) =>
		[
			'note',
			'notes',
			'package',
			'packages',
			'setup',
			'readme',
			'doc',
			'docs',
		].includes(token),
	)
}

/** Inspect queries about live device/playback state, not package notes. */
function isLiveStatusInspect(intent: SearchIntent): boolean {
	if (intent.task.name !== 'inspect') return false
	if (isPackageOrientedInspect(intent)) return false
	return (
		intent.constraints.some((constraint) => constraint.kind === 'state') ||
		intent.actions.some(
			(action) =>
				action.name === 'inspect' &&
				action.matchedTerms.some((term) =>
					[
						'check',
						'whether',
						'playing',
						'status',
						'running',
						'paused',
						'connected',
						'disconnected',
					].includes(term),
				),
		)
	)
}

function scoreTaskAffinity(
	candidate: SearchCandidate,
	intent: SearchIntent,
): Pick<
	SearchScoreComponents,
	| 'taskAffinity'
	| 'actionMatch'
	| 'appAvailability'
	| 'wrapperWorkflow'
	| 'constraint'
> {
	const taskConfidenceWeight = Math.min(
		1,
		Math.max(0.2, intent.task.confidence),
	)
	const matchedActionTerms = intent.actions.flatMap(
		(action) => action.matchedTerms,
	)
	const actionMatch =
		scoreSemanticMatchedTerms(candidate.searchFields, matchedActionTerms) *
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
			if (candidate.type === 'integration') taskAffinity += 0.08
			if (candidate.type === 'capability') taskAffinity -= 0.04
			break
		case 'setup':
			if (candidate.type === 'integration') taskAffinity += 0.18
			if (candidate.type === 'value') taskAffinity += 0.06
			if (candidate.type === 'capability') taskAffinity += 0.05
			break
		case 'inspect': {
			const packageOrientedInspect = isPackageOrientedInspect(intent)
			const liveStatusInspect = isLiveStatusInspect(intent)
			if (packageOrientedInspect) {
				if (candidate.type === 'capability') taskAffinity += 0.04
				if (candidate.type === 'value' || candidate.type === 'integration') {
					taskAffinity += 0.06
				}
				if (candidate.type === 'package') taskAffinity += 0.16
			} else if (liveStatusInspect) {
				const inspectionTerms = [
					'status',
					'list',
					'state',
					'current',
					'playing',
					'show',
					'check',
				] as const
				const inspectionKeyHits = inspectionTerms.filter(
					(term) => scoreMatchedTerms(candidate.searchFields, [term]) > 0,
				).length
				if (candidate.type === 'capability') {
					taskAffinity += 0.16 + Math.min(0.16, inspectionKeyHits * 0.08)
				}
				if (candidate.type === 'value' || candidate.type === 'integration') {
					taskAffinity += 0.06
				}
				if (candidate.type === 'package') {
					taskAffinity -= 0.12
					if (inspectionKeyHits === 0) taskAffinity -= 0.1
				}
			} else {
				if (candidate.type === 'value' || candidate.type === 'integration') {
					taskAffinity += 0.12
				}
				if (candidate.type === 'package') taskAffinity += 0.05
			}
			break
		}
		case 'learn':
			if (candidate.type === 'capability') taskAffinity += 0.16
			if (candidate.type === 'package') taskAffinity -= 0.02
			break
		case 'debug':
			if (candidate.type === 'integration') taskAffinity += 0.16
			if (candidate.type === 'package') {
				taskAffinity += 0.1
				if ('hasApp' in candidate.match && candidate.match.hasApp) {
					appAvailability += 0.08
				}
			}
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
		wrapperWorkflow: scorePackageWrapperWorkflowBoost(candidate, intent),
		constraint,
	}
}

function findStrongSynthesizedIdentityTerms(input: {
	candidates: Array<SearchCandidate>
	intent: SearchIntent
}): Map<string, Set<string>> {
	const queryIdentityTerms = getSearchIdentityTerms(input.intent)
	const candidatesByProvider = new Map<string, Array<SearchCandidate>>()
	for (const candidate of input.candidates) {
		if (!candidate.synthesizedProviderKey) continue
		const group =
			candidatesByProvider.get(candidate.synthesizedProviderKey) ?? []
		group.push(candidate)
		candidatesByProvider.set(candidate.synthesizedProviderKey, group)
	}

	const strongTermsByProvider = new Map<string, Set<string>>()
	for (const [providerKey, candidates] of candidatesByProvider) {
		const providerConcepts = new Set(
			candidates
				.flatMap((candidate) =>
					(candidate.providerIdentityFields ?? []).flatMap(extractSearchTokens),
				)
				.map(semanticSearchConcept),
		)
		const operationConceptCounts = new Map<string, number>()
		for (const candidate of candidates) {
			const candidateConcepts = new Set(
				(candidate.identityFields ?? [])
					.flatMap(extractSearchTokens)
					.map(semanticSearchConcept),
			)
			for (const concept of candidateConcepts) {
				operationConceptCounts.set(
					concept,
					(operationConceptCounts.get(concept) ?? 0) + 1,
				)
			}
		}
		const strongTerms = queryIdentityTerms.filter((term) => {
			const concept = semanticSearchConcept(term)
			return (
				providerConcepts.has(concept) ||
				(operationConceptCounts.get(concept) ?? 0) >= 2
			)
		})
		if (strongTerms.length > 0) {
			strongTermsByProvider.set(providerKey, new Set(strongTerms))
		}
	}
	return strongTermsByProvider
}

const maxSynthesizedProviderEntityAffinity = 1.1

function hasExactNonProviderEntityTarget(input: {
	candidates: ReadonlyArray<SearchCandidate>
	intent: SearchIntent
}): boolean {
	return input.candidates.some(
		(candidate) =>
			candidate.synthesizedProviderKey == null &&
			[candidate.id, candidate.title].some(
				(identity) =>
					normalizeSearchText(identity).trim() === input.intent.normalizedQuery,
			),
	)
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
	const strongIdentityTermsByProvider =
		findStrongSynthesizedIdentityTerms(input)
	const exactNonProviderEntityTarget = hasExactNonProviderEntityTarget(input)

	const reranked = input.candidates.map((candidate) => {
		const entityMatch =
			(entityConfidenceByKey.get(`${candidate.type}:${candidate.id}`) ?? 0) *
			0.45 *
			rerankWeight
		const strongIdentityTerms = candidate.synthesizedProviderKey
			? strongIdentityTermsByProvider.get(candidate.synthesizedProviderKey)
			: undefined
		const matchesStrongSynthesizedIdentity =
			strongIdentityTerms != null &&
			scoreSemanticMatchedTerms(
				[
					...(candidate.identityFields ?? []),
					...(candidate.providerIdentityFields ?? []),
				],
				[...strongIdentityTerms],
			) > 0
		const providerEntityAffinity =
			matchesStrongSynthesizedIdentity && !exactNonProviderEntityTarget
				? Math.min(
						maxSynthesizedProviderEntityAffinity,
						scoreSemanticMatchedTerms(
							[
								...candidate.searchFields,
								...(candidate.providerIdentityFields ?? []),
							],
							getSearchIdentityTerms(input.intent),
						) * maxSynthesizedProviderEntityAffinity,
					)
				: 0
		const taskSignals = scoreTaskAffinity(candidate, input.intent)
		const final =
			candidate.scoreComponents.base +
			entityMatch +
			providerEntityAffinity +
			taskSignals.actionMatch +
			taskSignals.taskAffinity +
			taskSignals.appAvailability +
			taskSignals.wrapperWorkflow +
			taskSignals.constraint

		return {
			...candidate,
			scoreComponents: {
				...candidate.scoreComponents,
				entityMatch,
				providerEntityAffinity,
				actionMatch: taskSignals.actionMatch,
				taskAffinity: taskSignals.taskAffinity,
				appAvailability: taskSignals.appAvailability,
				wrapperWorkflow: taskSignals.wrapperWorkflow,
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

async function buildCapabilityCandidates(input: {
	query: string
	env: Env
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	queryVector?: ReadonlyArray<number>
}): Promise<Array<SearchCandidate>> {
	const capabilitySearch = await searchCapabilities({
		env: input.env,
		query: input.query,
		limit: Math.max(1, Object.keys(input.registry.capabilitySpecs).length),
		detail: false,
		specs: input.registry.capabilitySpecs,
		...(input.queryVector ? { queryVector: input.queryVector } : {}),
	})

	return capabilitySearch.matches
		.map((match) => {
			const spec = input.registry.capabilitySpecs[match.name]
			if (!spec || spec.name !== match.name) {
				throw new Error(
					`Capability search result "${match.name}" did not map to a registry spec by name.`,
				)
			}
			return capabilityMatchToCandidate(match, spec)
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

/**
 * Queries Vectorize for this user's `package_{id}` vectors with
 * `{ kind: 'package', userId }`. Returns null when unavailable.
 */
async function queryPackageVectorScores(input: {
	env: Env
	query: string
	rows: Array<PackageSearchRow>
	userId: string
	limit: number
	queryVector?: ReadonlyArray<number>
}): Promise<Map<string, number> | null> {
	const index = getCapabilityVectorIndex(input.env)
	if (!index || !input.userId) return null
	const recordIdByVectorId = new Map(
		input.rows.map(
			(row) => [savedPackageVectorId(row.record.id), row.record.id] as const,
		),
	)
	const queryVector = [
		...(input.queryVector ??
			(await embedTextForVectorize(input.env, input.query))),
	]
	const topK = Math.min(Math.max(input.rows.length, input.limit * 5), 100)
	const vectorMatches = await index.query(queryVector, {
		topK,
		returnMetadata: 'none',
		filter: {
			kind: { $eq: 'package' },
			userId: { $eq: input.userId },
		},
	})
	const scores = new Map<string, number>()
	for (const match of vectorMatches.matches) {
		if (typeof match.id !== 'string') continue
		const recordId = recordIdByVectorId.get(match.id)
		if (!recordId || scores.has(recordId)) continue
		scores.set(recordId, match.score)
	}
	return scores
}

async function buildPackageCandidates(input: {
	env: Env
	query: string
	rows: Array<PackageSearchRow>
	queryEmbedding: ReadonlyArray<number>
	limit: number
	offline: boolean
	userId?: string
	queryVector?: ReadonlyArray<number>
}): Promise<Array<SearchCandidate>> {
	if (input.rows.length === 0) return []
	// Fail closed in every mode: no userId or foreign rows never enter ranking.
	if (!input.userId) return []
	if (input.rows.some((row) => row.record.userId !== input.userId)) {
		console.warn(
			JSON.stringify({
				message: 'package candidates skipped: row userId mismatch',
				expectedUserId: input.userId,
			}),
		)
		return []
	}
	const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
	let vectorScoresByRecordId: Map<string, number> | null = null
	if (!input.offline && input.userId) {
		try {
			vectorScoresByRecordId = await queryPackageVectorScores({
				env: input.env,
				query: input.query,
				rows: input.rows,
				userId: input.userId,
				limit: input.limit,
				...(input.queryVector ? { queryVector: input.queryVector } : {}),
			})
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: 'package vector query failed, using lexical ranking',
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
	}
	const candidates = input.rows
		.map((entry) => {
			const exports = Array.isArray(entry.projection.exports)
				? entry.projection.exports
				: []
			const jobs = Array.isArray(entry.projection.jobs)
				? entry.projection.jobs
				: []
			const retrievers = Array.isArray(entry.projection.retrievers)
				? entry.projection.retrievers
				: []
			const services = Array.isArray(entry.projection.services)
				? entry.projection.services
				: []
			const subscriptions = Array.isArray(entry.projection.subscriptions)
				? entry.projection.subscriptions
				: []
			const readmeSnippet = entry.readmeSnippet?.snippet ?? ''
			const actionMatches = buildPackageActionMatches({
				query: input.query,
				meaningfulTokens,
				exports,
			})
			const document = [
				buildPackageSearchDocument(entry.projection),
				readmeSnippet,
			]
				.filter((value) => value.trim().length > 0)
				.join('\n')
			const lexical = Math.max(
				lexicalScore(input.query, document),
				(actionMatches[0]?.score ?? 0) * 0.8,
			)
			const vectorHit = vectorScoresByRecordId?.get(entry.record.id)
			const scoreComponents =
				vectorScoresByRecordId != null
					? buildCandidateBaseScore({
							lexical,
							...(vectorHit !== undefined ? { vector: vectorHit } : {}),
						})
					: buildCandidateBaseScore({
							lexical,
							vector: cosineSimilarity(
								input.queryEmbedding,
								deterministicEmbedding(document),
							),
						})
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
					hidden: entry.record.hidden,
					readmeSnippet: entry.readmeSnippet ?? null,
					actionMatches,
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
					...exports.flatMap(buildPackageExportSearchFields),
					...jobs.flatMap((job) => [
						job.name,
						job.entry,
						job.schedule,
						job.enabled ? 'enabled' : 'disabled',
					]),
					...services.flatMap((service) => [
						service.name,
						service.entry,
						service.mode,
						service.autoStart ? 'auto-start' : 'manual-start',
						service.timeoutMs != null ? `timeout-ms:${service.timeoutMs}` : '',
					]),
					...subscriptions.flatMap((subscription) => [
						subscription.topic,
						subscription.handler,
						subscription.description ?? '',
					]),
					...retrievers.flatMap((retriever) => [
						retriever.key,
						retriever.name,
						retriever.description,
						retriever.exportName,
						...retriever.scopes,
					]),
					...(entry.projection.appEntry ? [entry.projection.appEntry] : []),
					readmeSnippet,
					...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
				],
				scoreComponents,
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
	if (!vectorScoresByRecordId) {
		return candidates
	}
	// Fuse lexical and vector rankings to bound the online candidate set.
	const candidateIds = candidates.map((candidate) => candidate.match.packageId)
	const lexicalById = new Map(
		candidates.map(
			(candidate) =>
				[candidate.match.packageId, candidate.scoreComponents.lexical] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(
		candidateIds,
		(id) => lexicalById.get(id) ?? 0,
	)
	const vectorHitIds = candidateIds.filter((id) =>
		vectorScoresByRecordId.has(id),
	)
	const vectorOrder = sortIdsByScore(
		vectorHitIds,
		(id) => vectorScoresByRecordId.get(id) ?? 0,
	)
	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const keptIds = new Set(
		sortIdsByScore(candidateIds, (id) => fused.get(id) ?? 0).slice(
			0,
			Math.min(
				maxFusedPackageCandidates,
				Math.max(input.limit * 5, input.limit),
			),
		),
	)
	return candidates.filter((candidate) =>
		keptIds.has(candidate.match.packageId),
	)
}

function buildRetrieverResultCandidates(input: {
	query: string
	results: Array<PackageRetrieverSurfaceResult>
}): Array<SearchCandidate> {
	return input.results
		.map((result) => {
			const lexical = lexicalScore(
				input.query,
				[
					result.title,
					result.summary,
					result.details ?? '',
					result.source ?? '',
					result.kodyId,
					result.retrieverName,
				].join('\n'),
			)
			const score = Math.min(1, Math.max(0, result.score ?? 0))
			return {
				match: {
					type: 'retriever_result' as const,
					...result,
				},
				type: 'retriever_result' as const,
				id: `${result.kodyId}:${result.retrieverKey}:${result.id}`,
				title: result.title,
				searchFields: [
					result.title,
					result.summary,
					result.details ?? '',
					result.source ?? '',
					result.kodyId,
					result.retrieverName,
				],
				scoreComponents: buildCandidateBaseScore({
					lexical: Math.max(lexical, score),
				}),
			} satisfies SearchCandidate
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

function buildValueCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
}): Array<SearchCandidate> {
	return input.rows
		.flatMap((row) => {
			if (parseIntegrationValueName(row.name)) return []
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

function buildIntegrationCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
	queryEmbedding: ReadonlyArray<number>
}): Array<SearchCandidate> {
	return input.rows
		.flatMap((row) => {
			const integrationName = parseIntegrationValueName(row.name)
			if (!integrationName) return []
			const config = parseIntegrationConfig(
				parseIntegrationJson(row.value),
				integrationName,
			)
			if (!config) return []
			const document = buildIntegrationSearchDocument({
				integrationName,
				description:
					row.description.trim() ||
					`Saved OAuth integration configuration (${config.flow} flow).`,
				config,
			})
			const lexical = lexicalScore(input.query, document)
			const vector = cosineSimilarity(
				input.queryEmbedding,
				deterministicEmbedding(document),
			)
			return [
				{
					match: {
						type: 'integration' as const,
						integrationName,
						title: integrationName,
						description:
							row.description.trim() ||
							`Saved OAuth integration configuration (${config.flow} flow).`,
						flow: config.flow,
						tokenUrl: config.tokenUrl,
						apiBaseUrl: config.apiBaseUrl ?? null,
						requiredHosts: config.requiredHosts ?? [],
						clientIdValueName: config.clientIdValueName,
						clientSecretSecretName: config.clientSecretSecretName ?? null,
						accessTokenSecretName: config.accessTokenSecretName,
						refreshTokenSecretName: config.refreshTokenSecretName ?? null,
						authorization: config.authorization ?? null,
					},
					type: 'integration' as const,
					id: integrationName,
					title: integrationName,
					searchFields: [
						integrationName,
						row.description,
						config.flow,
						config.apiBaseUrl ?? '',
						config.tokenUrl,
						config.authorization?.authorizeUrl ?? '',
						...(config.authorization?.scopes ?? []),
						...(config.requiredHosts ?? []),
					],
					scoreComponents: buildCandidateBaseScore({
						lexical,
						vector,
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

function getSynthesizedProviderIdentity(spec: CapabilitySpec):
	| {
			key: string
			providerFields: Array<string>
			operationFields: Array<string>
	  }
	| undefined {
	switch (spec.source) {
		case 'builtin':
			return undefined
		case 'remote-connector':
			return spec.remoteConnector
				? {
						key: `remote-connector:${spec.remoteConnector.instanceId}`,
						providerFields: [
							spec.remoteConnector.instanceId,
							spec.remoteConnector.connectorId,
							spec.remoteConnector.connectorName,
						],
						operationFields: [
							spec.remoteConnector.mcpToolName,
							spec.remoteConnector.toolName,
						],
					}
				: undefined
		case 'mcp-server':
			return spec.mcpServer
				? {
						key: `mcp-server:${spec.mcpServer.serverId}`,
						providerFields: [
							spec.mcpServer.serverName,
							spec.mcpServer.kodyName,
						],
						operationFields: [
							spec.mcpServer.mcpToolName,
							spec.mcpServer.toolName,
						],
					}
				: undefined
		case 'openapi':
			return spec.openApi
				? {
						key: `openapi:${spec.openApi.bindingName}`,
						providerFields: [spec.openApi.bindingName, spec.openApi.kodyName],
						operationFields: [spec.openApi.operationSlug],
					}
				: undefined
		default: {
			const exhaustiveSource: never = spec.source
			return exhaustiveSource
		}
	}
}

function capabilityMatchToCandidate(
	match: SearchCapabilityMatch,
	spec: CapabilitySpec,
): SearchCandidate {
	const providerIdentity = getSynthesizedProviderIdentity(spec)
	return {
		match: {
			type: 'capability',
			name: spec.name,
			description: spec.description,
			source: spec.source,
			...(spec.remoteConnector
				? { remoteConnector: spec.remoteConnector }
				: {}),
			...(spec.mcpServer ? { mcpServer: spec.mcpServer } : {}),
			...(spec.openApi ? { openApi: spec.openApi } : {}),
		},
		type: 'capability',
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
		identityFields: [
			spec.name,
			spec.domain,
			...(providerIdentity?.operationFields ?? []),
		],
		...(providerIdentity
			? {
					providerIdentityFields: providerIdentity.providerFields,
					synthesizedProviderKey: providerIdentity.key,
				}
			: {}),
		scoreComponents: buildCandidateBaseScore({
			lexical: match.lexicalScore,
			...(match.vectorRank != null ? { vector: match.vectorScore } : {}),
		}),
	}
}

function attachTopCapabilityCallShapes(input: {
	matches: Array<SearchMatch>
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	limit?: number
}): void {
	const limit = input.limit ?? topCapabilityInlineCallShapeCount
	let attached = 0
	for (const match of input.matches) {
		if (attached >= limit) break
		if (match.type !== 'capability') continue
		const spec = input.registry.capabilitySpecs[match.name]
		if (!spec?.inputTypeDefinition) continue
		const compact = compactCapabilityInputTypeDefinition(
			spec.inputTypeDefinition,
		)
		match.inputTypeDefinition = compact.definition
		if (compact.truncated) {
			match.inputTypeDefinitionTruncated = true
		}
		attached += 1
	}
}

function sameSynthesizedProvider(
	left: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string],
	right: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string],
): boolean {
	if (left.source !== right.source) return false
	if (left.source === 'openapi' && left.openApi && right.openApi) {
		return left.openApi.kodyName === right.openApi.kodyName
	}
	if (left.source === 'mcp-server' && left.mcpServer && right.mcpServer) {
		return left.mcpServer.kodyName === right.mcpServer.kodyName
	}
	if (
		left.source === 'remote-connector' &&
		left.remoteConnector &&
		right.remoteConnector
	) {
		return (
			left.remoteConnector.connectorName === right.remoteConnector.connectorName
		)
	}
	return false
}

function collectRelatedCapabilityOperations(input: {
	spec: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string]
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}): Array<RelatedCapabilityOperation> {
	const { spec, registry } = input
	if (
		spec.source !== 'openapi' &&
		spec.source !== 'mcp-server' &&
		spec.source !== 'remote-connector'
	) {
		return []
	}
	return Object.values(registry.capabilitySpecs)
		.filter(
			(other) =>
				other.name !== spec.name && sameSynthesizedProvider(spec, other),
		)
		.sort((left, right) => left.name.localeCompare(right.name))
		.slice(0, maxRelatedCapabilityOperations)
		.map((other) => ({
			name: other.name,
			entityRef: `${other.name}:capability`,
			description: other.description,
			...(other.openApi
				? { method: other.openApi.method, path: other.openApi.path }
				: {}),
		}))
}

async function hydrateTopPackageMatches(input: {
	query: string
	matches: Array<SearchMatch>
	rows: Array<PackageSearchRow>
}): Promise<void> {
	const rowsByRecordId = new Map(
		input.rows.map((row) => [row.record.id, row] as const),
	)
	const packageMatches = input.matches.flatMap((match) =>
		match.type === 'package' ? [match] : [],
	)
	if (packageMatches.length === 0) return
	const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
	await Promise.all(
		packageMatches.map(async (match) => {
			const row = rowsByRecordId.get(match.packageId)
			if (!row?.hydrate) return
			try {
				const hydrated = await row.hydrate()
				match.readmeSnippet = hydrated.readmeSnippet
				match.actionMatches = buildPackageActionMatches({
					query: input.query,
					meaningfulTokens,
					exports: hydrated.projection.exports,
				})
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: 'package search match hydration failed',
						packageId: match.packageId,
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			}
		}),
	)
}

export async function searchUnified(input: {
	env: Env
	query: string
	limit: number
	/** Authenticated user; required for fail-closed package Vectorize isolation. */
	userId?: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
	retrieverResults?: Array<PackageRetrieverSurfaceResult>
}): Promise<SearchUnifiedResult> {
	const offline = isCapabilitySearchOffline(input.env)
	const query = input.query.trim()
	if (!query) {
		const queryUnderstandingStart = performance.now()
		const emptyIntent = understandSearchQuery({
			query,
			entities: [],
		})
		const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
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
				queryUnderstandingMs,
				candidateGenerationMs: 0,
				rerankingMs: 0,
			},
		}
	}

	const limit = Math.max(1, input.limit)
	const entityDescriptors = buildSearchableEntityDescriptors({
		registry: input.registry,
		optionalRows: input.optionalRows,
	})
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({
		query,
		entities: entityDescriptors,
	})
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	const candidateGenerationStart = performance.now()
	const queryEmbeddingStart = performance.now()
	const queryEmbedding = deterministicEmbedding(intent.normalizedQuery)
	const sharedQueryVector = offline
		? queryEmbedding
		: await embedTextForVectorize(input.env, intent.normalizedQuery)
	const queryEmbeddingMs = elapsedMs(queryEmbeddingStart)

	const capabilityCandidatesStart = performance.now()
	const packageCandidatesStart = performance.now()
	const [capabilityCandidates, packageCandidates] = await Promise.all([
		buildCapabilityCandidates({
			query: intent.normalizedQuery,
			env: input.env,
			registry: input.registry,
			queryVector: sharedQueryVector,
		}).then((candidates) => ({
			candidates,
			durationMs: elapsedMs(capabilityCandidatesStart),
		})),
		buildPackageCandidates({
			env: input.env,
			query: intent.normalizedQuery,
			rows: input.optionalRows.packageRows,
			queryEmbedding,
			limit,
			offline,
			userId: input.userId,
			queryVector: offline ? undefined : sharedQueryVector,
		}).then((candidates) => ({
			candidates,
			durationMs: elapsedMs(packageCandidatesStart),
		})),
	])
	const candidates = [
		...capabilityCandidates.candidates,
		...packageCandidates.candidates,
		...buildValueCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.userValueRows,
		}),
		...buildIntegrationCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.userValueRows,
			queryEmbedding,
		}),
		...buildSecretCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.userSecretRows,
		}),
		...buildRetrieverResultCandidates({
			query: intent.normalizedQuery,
			results: input.retrieverResults ?? [],
		}),
	]
	const candidateGenerationMs = elapsedMs(candidateGenerationStart)
	const rerankingStart = performance.now()
	const reranked = rerankCandidates({
		candidates,
		intent,
		limit,
	})
	const matches = reranked.map((candidate) => candidate.match)
	attachTopCapabilityCallShapes({
		matches,
		registry: input.registry,
	})
	await hydrateTopPackageMatches({
		query: intent.normalizedQuery,
		matches,
		rows: input.optionalRows.packageRows,
	})
	const rerankingMs = elapsedMs(rerankingStart)

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
			queryEmbeddingMs,
			capabilityCandidatesMs: capabilityCandidates.durationMs,
			packageCandidatesMs: packageCandidates.durationMs,
		},
		guidance: buildRecommendedNextStep({
			query,
			intent,
			matches,
		}),
	}
}

export async function searchPackages(input: {
	env: Env
	baseUrl: string
	query: string
	limit: number
	userId?: string
	rows: Array<PackageSearchRow>
}): Promise<{ matches: Array<SearchMatch>; offline: boolean }> {
	const result = await searchUnified({
		env: input.env,
		query: input.query,
		limit: input.limit,
		userId: input.userId,
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

export type SearchMemoryEnrichmentSettlement = {
	memories?: {
		surfaced: MemoryToolSummary['memories']
		suppressedCount: number
		retrievalQuery: string
		retrieverResults: MemoryToolSummary['retrieverResults']
	}
	warnings: Array<string>
	phaseTimings: Pick<
		SearchPhaseTimings,
		| 'memoryEnrichmentMs'
		| 'memoryEnrichmentWaitMs'
		| 'memoryAcknowledgementMs'
		| 'memoryEnrichmentTimedOut'
		| 'memoryAcknowledgementTimedOut'
		| 'memoryEnrichmentFailed'
		| 'memoryAcknowledgementFailed'
	>
}

export function launchSearchMemoryEnrichment(input: {
	env: Env
	callerContext: McpCallerContext
	conversationId: string
	query?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
}): {
	promise: Promise<MemoryToolSummary | null>
	launchedAtMs: number
} | null {
	const userId = input.callerContext.user?.userId ?? null
	const memoryContext = resolveSearchMemoryContext({
		query: input.query,
		memoryContext: input.memoryContext,
	})
	if (!userId || !buildMemoryRetrievalQuery(memoryContext)) return null
	const launchedAtMs = performance.now()
	const promise = loadRelevantMemoriesForTool({
		env: input.env,
		callerContext: input.callerContext,
		conversationId: input.conversationId,
		memoryContext,
		acknowledgeSurfaced: false,
	})
	void promise.catch(() => {})
	return { promise, launchedAtMs }
}

export async function settleSearchMemoryEnrichment(input: {
	env: Env
	callerContext: McpCallerContext
	conversationId: string
	promise: Promise<MemoryToolSummary | null>
	launchedAtMs?: number
	budgetMs?: number
	acknowledgementBudgetMs?: number
}): Promise<SearchMemoryEnrichmentSettlement> {
	const waitStartedAt = performance.now()
	const launchedAtMs = input.launchedAtMs ?? waitStartedAt
	const budgetMs = input.budgetMs ?? SEARCH_MEMORY_ENRICHMENT_BUDGET_MS
	const settlement = await settleWithBudget(
		input.promise,
		budgetMs,
		launchedAtMs,
	)
	const memoryEnrichmentWaitMs = elapsedMs(waitStartedAt)
	const memoryEnrichmentMs = settlement.durationMs

	if (!settlement.ok) {
		console.warn(
			JSON.stringify({
				message: 'search memory enrichment skipped',
				reason: settlement.timedOut ? 'timeout' : 'failure',
				budgetMs,
				waitedMs: memoryEnrichmentWaitMs,
				launchToSettleMs: memoryEnrichmentMs,
				...(settlement.failed
					? {
							error:
								settlement.error instanceof Error
									? settlement.error.message
									: String(settlement.error),
						}
					: {}),
			}),
		)
		return {
			warnings: [memoryEnrichmentSkippedWarning],
			phaseTimings: {
				memoryEnrichmentMs,
				memoryEnrichmentWaitMs,
				memoryEnrichmentTimedOut: settlement.timedOut,
				memoryEnrichmentFailed: settlement.failed,
			},
		}
	}

	const memoryToolContext = settlement.value
	const warnings = [...(memoryToolContext?.retrieverWarnings ?? [])]
	if (!memoryToolContext || memoryToolContext.memories.length === 0) {
		return {
			...(memoryToolContext
				? {
						memories: {
							surfaced: memoryToolContext.memories,
							suppressedCount: memoryToolContext.suppressedCount,
							retrievalQuery: memoryToolContext.retrievalQuery,
							retrieverResults: memoryToolContext.retrieverResults,
						},
					}
				: {}),
			warnings,
			phaseTimings: {
				memoryEnrichmentMs,
				memoryEnrichmentWaitMs,
				memoryEnrichmentTimedOut: false,
				memoryEnrichmentFailed: false,
			},
		}
	}

	const memories = {
		surfaced: memoryToolContext.memories,
		suppressedCount: memoryToolContext.suppressedCount,
		retrievalQuery: memoryToolContext.retrievalQuery,
		retrieverResults: memoryToolContext.retrieverResults,
	}
	const acknowledgementBudgetMs =
		input.acknowledgementBudgetMs ?? SEARCH_MEMORY_ACKNOWLEDGEMENT_BUDGET_MS
	const acknowledgementStartedAt = performance.now()
	const acknowledgementPromise = acknowledgeToolMemories({
		env: input.env,
		callerContext: input.callerContext,
		conversationId: input.conversationId,
		memoryIds: memoryToolContext.memories.map((memory) => memory.id),
	})
	const acknowledgement = await settleWithBudget(
		acknowledgementPromise,
		acknowledgementBudgetMs,
		acknowledgementStartedAt,
	)
	const memoryAcknowledgementMs = elapsedMs(acknowledgementStartedAt)

	if (acknowledgement.ok) {
		return {
			memories,
			warnings,
			phaseTimings: {
				memoryEnrichmentMs,
				memoryEnrichmentWaitMs,
				memoryAcknowledgementMs,
				memoryEnrichmentTimedOut: false,
				memoryEnrichmentFailed: false,
			},
		}
	}

	if (acknowledgement.timedOut) {
		void acknowledgementPromise.catch((error) => {
			console.warn(
				JSON.stringify({
					message: 'search memory acknowledgement failed after timeout',
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		})
		console.warn(
			JSON.stringify({
				message: 'search memory acknowledgement timed out',
				budgetMs: acknowledgementBudgetMs,
				acknowledgementMs: memoryAcknowledgementMs,
			}),
		)
		return {
			memories,
			warnings: [...warnings, memoryAcknowledgementWarning],
			phaseTimings: {
				memoryEnrichmentMs,
				memoryEnrichmentWaitMs,
				memoryAcknowledgementMs,
				memoryEnrichmentTimedOut: false,
				memoryAcknowledgementTimedOut: true,
				memoryEnrichmentFailed: false,
			},
		}
	}

	console.warn(
		JSON.stringify({
			message: 'search memory acknowledgement failed',
			error:
				acknowledgement.error instanceof Error
					? acknowledgement.error.message
					: String(acknowledgement.error),
			acknowledgementMs: memoryAcknowledgementMs,
		}),
	)
	return {
		memories,
		warnings: [...warnings, memoryAcknowledgementWarning],
		phaseTimings: {
			memoryEnrichmentMs,
			memoryEnrichmentWaitMs,
			memoryAcknowledgementMs,
			memoryEnrichmentTimedOut: false,
			memoryEnrichmentFailed: false,
			memoryAcknowledgementFailed: true,
		},
	}
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
	title: 'Search Capabilities, Packages, Values, Integrations, and Secrets',
	description: `
Find **built-in capabilities**, **saved packages**, **persisted values**,
**saved integrations**, and **user secret references** (metadata only)
before \`execute\`.

**query** — compact ranked markdown + structured matches (order matters). Query
markdown is summary-only: type, title/name, one-line description, and entity ref.
If nothing useful returns, rephrase or call \`meta_list_capabilities\`; \`entity\`
does not fix an empty ranked list.

An entire saved-package UUID, kody id, current-origin account package URL, or
owner-matching hosted package URL resolves as exact user-scoped package identity
without competing semantic matches. Hidden exact queries require
\`includeHiddenPackages: true\`.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`value\`
| \`integration\` | \`package\` | \`secret\`), or an array of 1–10 refs to batch
related lookups in one call. Capability detail includes an exact \`execute\`
module snippet plus TypeScript call-shape definitions by default. Synthesized
provider capabilities (OpenAPI, MCP server, remote connector) also list related
operations from the same provider. Package ids may be UUIDs or kody ids, and
hidden packages resolve here regardless of \`includeHiddenPackages\`.

Secret results expose metadata only; credential values never appear.

If results look incomplete: \`meta_list_capabilities\` (full registry) or
\`meta_list_remote_connector_status\` (remote connectors).

Optional **limit** (default 15) and **maxResponseSize** trim low-ranked results.
Example arguments:
- \`{ "query": "saved github automation package", "limit": 10 }\`
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

type SearchRowsAndRegistry = OptionalSearchRowsResult & {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}

function shouldIncludeRemoteConnectorStatus(status: RemoteConnectorStatus) {
	return status.state !== 'connected' || status.toolCount === 0
}

export function serializeRemoteConnectorStatus(status: RemoteConnectorStatus): {
	connectorId: string
	state: string
	connected: boolean
	toolCount: number
} {
	return {
		connectorId: status.connectorId ?? 'unknown',
		state: status.state,
		connected: status.connected,
		toolCount: status.toolCount,
	}
}

export async function loadDownRemoteConnectorStatuses(input: {
	env: Env
	callerContext: Pick<McpCallerContext, 'remoteConnectors' | 'user'>
}): Promise<Array<RemoteConnectorStatus>> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return []
	}
	const statuses = await Promise.all(
		refs.map((ref) =>
			getRemoteConnectorStatus({ env: input.env, userId, ref }),
		),
	)
	return statuses.filter(shouldIncludeRemoteConnectorStatus)
}

export async function loadOptionalSearchRows(input: {
	userId: string | null
	loadPackages: () => Promise<LoadedPackageRows>
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

	const [loadedPackageRows, userSecretRows, userValueRows] = await Promise.all([
		input.loadPackages(),
		input.loadUserSecrets(),
		input.loadUserValues(),
	])
	const packageRows = Array.isArray(loadedPackageRows)
		? loadedPackageRows
		: loadedPackageRows.rows

	return {
		packageRows,
		userSecretRows,
		userValueRows,
		warnings: [],
	}
}

export async function loadSearchRowsAndRegistry(input: {
	env: Env
	callerContext: McpCallerContext
	userId: string | null
	includeHiddenPackages?: boolean
}) {
	const [registry, optionalRows] = await Promise.all([
		getCapabilityRegistryForContext({
			env: input.env,
			callerContext: input.callerContext,
		}),
		loadOptionalSearchRows({
			userId: input.userId,
			loadPackages: async () => {
				const savedPackages = await listSavedPackagesByUserId(
					input.env.APP_DB,
					{
						userId: input.userId!,
					},
				)
				const packageRows = await buildSavedPackageSearchRows({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					userId: input.userId!,
					records: savedPackages.filter((pkg) =>
						input.includeHiddenPackages ? true : !pkg.hidden,
					),
				})
				return packageRows
			},
			loadUserSecrets: () =>
				listUserSecretsForSearch({
					env: input.env,
					userId: input.userId!,
				}),
			loadUserValues: () =>
				listValues({
					env: input.env,
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

function findIntegrationDetail(
	rows: Array<ValueMetadata>,
	integrationName: string,
) {
	for (const row of rows) {
		if (parseIntegrationValueName(row.name) !== integrationName) continue
		const config = parseIntegrationConfig(
			parseIntegrationJson(row.value),
			integrationName,
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
	username: string | null
	entity: string
	searchRows: SearchRowsAndRegistry
}) {
	const ref = parseEntityRef(input.entity)
	if (ref.type === 'capability') {
		const spec = input.searchRows.registry.capabilitySpecs[ref.id]
		if (!spec) {
			throw new Error('Capability not found.')
		}
		const relatedOperations = collectRelatedCapabilityOperations({
			spec,
			registry: input.searchRows.registry,
		})
		return {
			type: 'capability' as const,
			id: ref.id,
			title: spec.name,
			description: spec.description,
			spec,
			...(relatedOperations.length > 0 ? { relatedOperations } : {}),
		}
	}

	if (!input.userId) {
		throw new Error('Authentication required to access saved user entities.')
	}

	if (ref.type === 'package') {
		const record =
			(await getSavedPackageById(input.agent.getEnv().APP_DB, {
				userId: input.userId,
				packageId: ref.id,
			})) ??
			(await getSavedPackageByKodyId(input.agent.getEnv().APP_DB, {
				userId: input.userId,
				kodyId: ref.id,
			}))
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
			baseUrl: input.callerContext.baseUrl,
			ownerUsername: input.username,
			hostedUrl:
				record.hasApp && input.username
					? buildPackageAppUrl({
							origin: input.callerContext.baseUrl,
							username: input.username,
							kodyId: record.kodyId,
						})
					: null,
		}
	}

	if (ref.type === 'value') {
		const valueRef = parseValueEntityId(ref.id)
		const row =
			input.searchRows.userValueRows.find(
				(value) =>
					value.scope === valueRef.scope && value.name === valueRef.name,
			) ??
			(await getValue({
				env: input.agent.getEnv(),
				userId: input.userId,
				name: valueRef.name,
				scope: valueRef.scope,
				storageContext: {
					sessionId: input.callerContext.storageContext?.sessionId ?? null,
					appId: input.callerContext.storageContext?.appId ?? null,
				},
			}))
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

	if (ref.type === 'integration') {
		const integration = findIntegrationDetail(
			input.searchRows.userValueRows,
			ref.id,
		)
		if (!integration) {
			throw new Error('Saved integration not found for this user.')
		}
		return {
			type: 'integration' as const,
			id: integration.config.name,
			title: integration.config.name,
			description:
				integration.row.description.trim() ||
				`Saved OAuth integration configuration (${integration.config.flow} flow).`,
			row: integration.row,
			config: integration.config,
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
			},
			annotations: searchTool.annotations,
		},
		async (args: {
			query?: string
			entity?: string | Array<string>
			limit?: number
			maxResponseSize?: number
			conversationId?: string
			memoryContext?: z.infer<typeof memoryContextInputField>
			includeHiddenPackages?: boolean
		}) => {
			const timingStart = startToolTiming()
			const conversationId = resolveConversationId(args.conversationId)
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const userId = callerContext.user?.userId ?? null
			const includeHiddenPackages = !!args.includeHiddenPackages
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
			let remoteConnectorDownStatuses: Array<RemoteConnectorStatus> = []
			let username: string | null = null
			const endToEndPhaseTimings: Partial<SearchPhaseTimings> = {}
			let memoryEnrichmentPromise: Promise<MemoryToolSummary | null> =
				Promise.resolve(null)
			let memoryEnrichmentLaunchedAtMs: number | undefined

			const searchSpan = async () => {
				const query = args.query?.trim() ?? ''
				username = await resolvePublicUsername({
					db: agent.getEnv().APP_DB,
					username: callerContext.user?.username ?? null,
					email: callerContext.user?.email ?? null,
				})
				if (!args.entity) {
					const launched = launchSearchMemoryEnrichment({
						env: agent.getEnv(),
						callerContext,
						conversationId,
						query: args.query,
						memoryContext: args.memoryContext,
					})
					if (launched) {
						memoryEnrichmentLaunchedAtMs = launched.launchedAtMs
						memoryEnrichmentPromise = launched.promise
					}
				}
				if (!args.entity && query) {
					const identityResolution = await resolvePackageIdentitySearch({
						db: agent.getEnv().APP_DB,
						userId,
						query,
						baseUrl,
						username,
						includeHiddenPackages,
					})
					if (identityResolution.recognized) {
						const remoteConnectorStatusStart = performance.now()
						remoteConnectorDownStatuses = await loadDownRemoteConnectorStatuses(
							{
								env: agent.getEnv(),
								callerContext,
							},
						)
						endToEndPhaseTimings.remoteConnectorStatusMs = elapsedMs(
							remoteConnectorStatusStart,
						)
						return {
							mode: 'list' as const,
							result: buildExactPackageSearchResult({
								env: agent.getEnv(),
								query,
								match: identityResolution.match,
							}),
						}
					}
				}
				const rowAndRegistryLoadStart = performance.now()
				const rowsPromise = loadSearchRowsAndRegistry({
					env: agent.getEnv(),
					callerContext,
					userId,
					includeHiddenPackages,
				}).then((rows) => {
					endToEndPhaseTimings.rowAndRegistryLoadMs = elapsedMs(
						rowAndRegistryLoadStart,
					)
					return rows
				})
				const retrieversStart = performance.now()
				const retrieverRunPromise =
					!args.entity && userId && query
						? (async () => {
								const { runPackageRetrievers } =
									await import('#worker/package-retrievers/service.ts')
								return await runPackageRetrievers({
									env: agent.getEnv(),
									baseUrl,
									userId,
									scope: 'search',
									query,
									includeHiddenPackages,
									memoryContext: resolveSearchMemoryContext({
										query,
										memoryContext: args.memoryContext,
									}),
									conversationId,
								})
							})().then((retrieverRun) => {
								endToEndPhaseTimings.retrieversMs = elapsedMs(retrieversStart)
								return retrieverRun
							})
						: Promise.resolve({ results: [], warnings: [] }).then(
								(retrieverRun) => {
									endToEndPhaseTimings.retrieversMs = elapsedMs(retrieversStart)
									return retrieverRun
								},
							)
				const [searchRows] = await Promise.all([
					rowsPromise,
					retrieverRunPromise,
				])
				const remoteConnectorStatusStart = performance.now()
				remoteConnectorDownStatuses = await loadDownRemoteConnectorStatuses({
					env: agent.getEnv(),
					callerContext,
				})
				endToEndPhaseTimings.remoteConnectorStatusMs = elapsedMs(
					remoteConnectorStatusStart,
				)
				warnings = searchRows.warnings

				if (args.entity) {
					if (Array.isArray(args.entity)) {
						const batchResults = await Promise.all(
							args.entity.map(async (entityRef) => {
								try {
									const detail = await resolveEntityDetail({
										agent,
										callerContext,
										userId,
										username,
										entity: entityRef,
										searchRows,
									})
									return {
										ok: true as const,
										entityRef,
										detail,
									}
								} catch (cause) {
									const error =
										cause instanceof Error ? cause : new Error(String(cause))
									return {
										ok: false as const,
										entityRef,
										error: error.message,
									}
								}
							}),
						)
						return {
							mode: 'entity-batch' as const,
							results: batchResults,
						}
					}
					return {
						mode: 'entity' as const,
						detail: await resolveEntityDetail({
							agent,
							callerContext,
							userId,
							username,
							entity: args.entity,
							searchRows,
						}),
					}
				}

				const retrieverRun = await retrieverRunPromise
				warnings.push(...retrieverRun.warnings)
				const result = await searchUnified({
					env: agent.getEnv(),
					query,
					limit,
					userId: userId ?? undefined,
					registry: searchRows.registry,
					optionalRows: searchRows,
					retrieverResults: retrieverRun.results,
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
					  }
					| {
							mode: 'entity-batch'
							results: Array<
								| {
										ok: true
										entityRef: string
										detail: Awaited<ReturnType<typeof resolveEntityDetail>>
								  }
								| {
										ok: false
										entityRef: string
										error: string
								  }
							>
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

				if (outcome.mode === 'entity-batch') {
					const timing = finishToolTiming(timingStart)
					const structuredResults: Array<
						SearchEntityDetailStructured | { entityRef: string; error: string }
					> = []
					const markdownParts: Array<string> = []
					let successCount = 0
					for (const entry of outcome.results) {
						if (!entry.ok) {
							structuredResults.push({
								entityRef: entry.entityRef,
								error: entry.error,
							})
							markdownParts.push(
								`Error resolving ${formatMarkdownInlineCode(entry.entityRef)}: ${escapeMarkdownText(entry.error)}`,
							)
							continue
						}
						const entityResult = formatEntityDetailMarkdown(entry.detail)
						const candidateStructured = [
							...structuredResults,
							entityResult.structured,
						]
						const hasFullDetail = structuredResults.some(
							(result) => 'kind' in result && result.kind === 'entity',
						)
						if (
							hasFullDetail &&
							JSON.stringify(candidateStructured).length > maxChars
						) {
							const overflowError =
								'Omitted from batch response (exceeds size budget). Look up individually with search({ entity }).'
							structuredResults.push({
								entityRef: entry.entityRef,
								error: overflowError,
							})
							markdownParts.push(
								`Error resolving ${formatMarkdownInlineCode(entry.entityRef)}: ${escapeMarkdownText(overflowError)}`,
							)
							continue
						}
						successCount += 1
						structuredResults.push(entityResult.structured)
						markdownParts.push(entityResult.markdown)
					}
					const allFailed = successCount === 0
					logMcpEvent({
						category: 'mcp',
						tool: 'search',
						toolName: 'search',
						outcome: allFailed ? 'failure' : 'success',
						durationMs: timing.durationMs,
						baseUrl,
						hasUser,
						...(allFailed
							? {
									sandboxError: false,
									errorName: 'EntityBatchError',
									errorMessage: 'All entity lookups failed.',
								}
							: {}),
					})
					return {
						content: prependToolMetadataContent(conversationId, [
							{
								type: 'text',
								text: truncateSearchText(markdownParts.join('\n\n---\n\n')),
							},
						]),
						structuredContent: {
							conversationId,
							timing,
							result: structuredResults,
							...(allFailed ? { error: 'All entity lookups failed.' } : {}),
						},
						...(allFailed ? { isError: true } : {}),
					}
				}

				const normalizedRemoteConnectorStatuses =
					remoteConnectorDownStatuses.length > 0
						? remoteConnectorDownStatuses.map(serializeRemoteConnectorStatus)
						: undefined
				const memorySettlement = await settleSearchMemoryEnrichment({
					env: agent.getEnv(),
					callerContext,
					conversationId,
					promise: memoryEnrichmentPromise,
					launchedAtMs: memoryEnrichmentLaunchedAtMs,
				})
				Object.assign(endToEndPhaseTimings, memorySettlement.phaseTimings)
				warnings.push(...memorySettlement.warnings)
				const searchMemories = memorySettlement.memories
				const structuredWarnings = [...warnings]

				const payload: {
					matches: Array<SearchMatch>
					offline: boolean
					remoteConnectorStatuses?: Array<{
						connectorId: string
						state: string
						connected: boolean
						toolCount: number
					}>
				} = {
					matches: outcome.result.matches,
					offline: outcome.result.offline,
					...(normalizedRemoteConnectorStatuses
						? {
								remoteConnectorStatuses: normalizedRemoteConnectorStatuses,
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
				const formattingStartMs = performance.now()
				const { payload: trimmedPayload, serialized } = applyMaxResponseSize(
					payload,
					maxResponseSize,
					(value) =>
						formatSearchMarkdown({
							matches: value.matches,
							warningCount: structuredWarnings.length,
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
				const formattingMs = elapsedMs(formattingStartMs)
				const result: SearchResultStructuredContent = {
					offline: trimmedPayload.offline,
					warnings: structuredWarnings,
					...(outcome.result.guidance
						? {
								guidance: outcome.result.guidance,
							}
						: {}),
					telemetry: {
						...outcome.result.telemetry,
						topResultTypes: trimmedPayload.matches
							.slice(0, 5)
							.map((match) => match.type),
						trimmedMatchCount,
						responseTrimmed: trimmedMatchCount > 0,
					},
					phaseTimings: {
						...outcome.result.phaseTimings,
						...endToEndPhaseTimings,
						formattingMs,
					},
					...(searchMemories
						? {
								memories: searchMemories,
							}
						: {}),
					...(trimmedPayload.remoteConnectorStatuses
						? {
								remoteConnectorStatuses: trimmedPayload.remoteConnectorStatuses,
							}
						: {}),
					matches: toSlimStructuredMatches({
						matches: trimmedPayload.matches,
						baseUrl,
						username,
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
