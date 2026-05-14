import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	parseIntegrationConfig,
	parseIntegrationJson,
	parseIntegrationValueName,
} from '#mcp/capabilities/values/integration-shared.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	blendLexicalAndVectorScore,
	cosineSimilarity,
	deterministicEmbedding,
	isCapabilitySearchOffline,
	lexicalScore,
	searchCapabilities,
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
	type PackageActionMatch,
	type SearchMatch,
	type SearchResultStructuredContent,
	buildPackageActionImportUsage,
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

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken
const defaultSearchLimit = 15
const defaultMaxResponseSize = 4_000

export type PackageSearchRow = {
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]
	projection: PackageSearchProjection
	readmeSnippet?: PackageReadmeSnippet | null
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

function buildFallbackPackageSearchProjection(
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number],
): PackageSearchProjection {
	return {
		name: record.name,
		kodyId: record.kodyId,
		description: record.description,
		tags: record.tags,
		searchText: record.searchText,
		// Preserve the saved-record app signal for discoverability even when manifest
		// hydration fails and we cannot recover the concrete app entry path.
		hasApp: record.hasApp,
		appEntry: null,
		exports: [],
		jobs: [],
		services: [],
		subscriptions: [],
		retrievers: [],
	}
}

export type BuildSavedPackageSearchRowsResult = {
	rows: Array<PackageSearchRow>
	warnings: Array<string>
}

export async function buildSavedPackageSearchRows(input: {
	env: Env
	baseUrl: string
	userId: string
	records: Array<Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]>
}): Promise<BuildSavedPackageSearchRowsResult> {
	const warnings: Array<string> = []
	const rows = await Promise.all(
		input.records.map(async (record) => {
			try {
				const loaded = await loadPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: record.sourceId,
				})
				return {
					record,
					projection: buildPackageSearchProjection(
						loaded.manifest,
						loaded.files,
					),
					readmeSnippet: buildPackageReadmeSnippet({
						files: loaded.files,
						maxChars: 1_000,
					}),
				}
			} catch (cause) {
				Sentry.captureException(cause, {
					tags: {
						scope: 'search.buildSavedPackageSearchRows',
					},
					extra: {
						kodyId: record.kodyId,
						sourceId: record.sourceId,
					},
				})
				const message = cause instanceof Error ? cause.message : String(cause)
				warnings.push(
					`Saved package "${record.kodyId}" search metadata is partially unavailable; using fallback metadata from source "${record.sourceId}": ${message}`,
				)
				return {
					record,
					projection: buildFallbackPackageSearchProjection(record),
				}
			}
		}),
	)
	return { rows, warnings }
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
			? `Open the saved app with \`open_generated_ui({ kody_id: "${topMatch.kodyId}" })\` or inspect package detail with \`search({ entity: "${topMatch.kodyId}:package" })\` to review exports and jobs.`
			: `Inspect package detail with \`search({ entity: "${topMatch.kodyId}:package" })\` to review exports, then import the right entry from \`${buildPackageImportSpecifier(topMatch.name, '.')}\` or a subpath export.`
	}
	if (topMatch?.type === 'integration') {
		return `Inspect integration detail with \`search({ entity: "${topMatch.integrationName}:integration" })\` and then run a minimal authenticated \`execute\` smoke test before building or calling integration-backed code.`
	}
	if (topMatch?.type === 'capability') {
		return `Inspect capability detail with \`search({ entity: "${topMatch.name}:capability" })\` to confirm the TypeScript call shape, then call it from \`execute\` via \`codemode.${topMatch.name}(args)\`.`
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
			)
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
			if (candidate.type === 'integration') taskAffinity += 0.08
			if (candidate.type === 'capability') taskAffinity -= 0.04
			break
		case 'setup':
			if (candidate.type === 'integration') taskAffinity += 0.18
			if (candidate.type === 'value') taskAffinity += 0.06
			if (candidate.type === 'capability') taskAffinity += 0.05
			break
		case 'inspect':
			if (candidate.type === 'value' || candidate.type === 'integration') {
				taskAffinity += 0.12
			}
			if (candidate.type === 'package') taskAffinity += 0.05
			break
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
			taskSignals.wrapperWorkflow +
			taskSignals.constraint

		return {
			...candidate,
			scoreComponents: {
				...candidate.scoreComponents,
				entityMatch,
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
}): Promise<Array<SearchCandidate>> {
	const capabilitySearch = await searchCapabilities({
		env: input.env,
		query: input.query,
		limit: Math.max(1, Object.keys(input.registry.capabilitySpecs).length),
		detail: false,
		specs: input.registry.capabilitySpecs,
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

function buildPackageCandidates(input: {
	query: string
	rows: Array<PackageSearchRow>
	queryEmbedding: ReadonlyArray<number>
}): Array<SearchCandidate> {
	const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
	return input.rows
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
				scoreComponents: buildCandidateBaseScore({
					lexical: Math.max(lexical, (actionMatches[0]?.score ?? 0) * 0.8),
					vector,
				}),
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
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

function capabilityMatchToCandidate(
	match: SearchCapabilityMatch,
	spec: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string],
): SearchCandidate {
	return {
		match: {
			type: 'capability',
			name: spec.name,
			description: spec.description,
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
		scoreComponents: buildCandidateBaseScore({
			lexical: match.lexicalScore,
			vector: match.vectorScore,
		}),
	}
}

export async function searchUnified(input: {
	env: Env
	query: string
	limit: number
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
		const queryUnderstandingMs = Math.max(
			0,
			Math.round(performance.now() - queryUnderstandingStart),
		)
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
	const queryUnderstandingMs = Math.max(
		0,
		Math.round(performance.now() - queryUnderstandingStart),
	)
	const candidateGenerationStart = performance.now()
	const queryEmbedding = deterministicEmbedding(intent.normalizedQuery)
	const candidates = [
		...(await buildCapabilityCandidates({
			query: intent.normalizedQuery,
			env: input.env,
			registry: input.registry,
		})),
		...buildPackageCandidates({
			query: intent.normalizedQuery,
			rows: input.optionalRows.packageRows,
			queryEmbedding,
		}),
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
	rows: Array<PackageSearchRow>
}): Promise<{ matches: Array<SearchMatch>; offline: boolean }> {
	const result = await searchUnified({
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
	title: 'Search Capabilities, Packages, Values, Integrations, and Secrets',
	description: `
Find **built-in capabilities**, **saved packages**, **persisted values**,
**saved integrations**, and **user secret references** (metadata only)
before \`execute\` or \`open_generated_ui\`.

**query** — compact ranked markdown + structured matches (order matters). Query
markdown is summary-only: type, title/name, one-line description, and entity ref.
If nothing useful returns, rephrase or call \`meta_list_capabilities\`; \`entity\`
does not fix an empty ranked list.

**entity: "{id}:{type}"** — detail for one hit (\`capability\` | \`value\`
| \`integration\` | \`package\` | \`secret\`). Capability detail includes an
exact \`execute\` module snippet plus TypeScript call-shape definitions by
default.

Packages: \`package_list\`, \`package_get\`, and \`repo_*\` for editing/publishing.
Open package apps with \`open_generated_ui({ kody_id })\` or use hosted package URLs.
Secrets: never raw in results; use
\`codemode.secret_list\` during execute and UI for missing values.
Persisted values use \`codemode.value_get\` / \`codemode.value_list\`. Integrations
use \`codemode.integration_get\` / \`codemode.integration_list\`.

Integration-backed packages, package apps, and workflows: search for the provider
and \`kody_official_guide\`, inspect exact \`integration\` or \`secret\` entities,
load \`guide: "integration_bootstrap"\`, and continue only after a cheap
authenticated \`execute\` smoke test succeeds. If setup is missing, use the guide
that matches the auth path: \`oauth\`, \`connect_secret\`, or
\`secret_backed_integration\`.

If results look incomplete: \`meta_list_capabilities\` (full registry) or
\`meta_list_remote_connector_status\` (remote connectors).

Optional **limit** (default 15) and **maxResponseSize** trim low-ranked results.
Example arguments:
- \`{ "query": "saved github automation package", "limit": 10 }\`
- \`{ "query": "preferred org value or saved integration", "limit": 10 }\`
- \`{ "query": "package with worker app ui", "limit": 10 }\`
- \`{ "entity": "kody_official_guide:capability" }\`
- \`{ "entity": "user:preferred_org:value" }\`
- \`{ "entity": "github:integration" }\`
- To open a saved package app: \`open_generated_ui({ "kody_id": "<kody-id>" })\`

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

function serializeRemoteConnectorStatus(status: RemoteConnectorStatus): {
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

	const warnings: Array<string> = []
	const [packageRowsResult, userSecretRowsResult, userValueRowsResult] =
		await Promise.allSettled([
			input.loadPackages(),
			input.loadUserSecrets(),
			input.loadUserValues(),
		])

	let packageRows: Array<PackageSearchRow> = []
	if (packageRowsResult.status === 'fulfilled') {
		if (Array.isArray(packageRowsResult.value)) {
			packageRows = packageRowsResult.value
		} else {
			packageRows = packageRowsResult.value.rows
			warnings.push(...packageRowsResult.value.warnings)
		}
	} else {
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
				const packageRows = await buildSavedPackageSearchRows({
					env: input.agent.getEnv(),
					baseUrl: input.callerContext.baseUrl,
					userId: input.userId!,
					records: savedPackages,
				})
				return packageRows
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
					.describe('Natural language description of the capability you need.'),
				entity: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Optional exact entity reference in the format "{id}:{type}" where type is capability, package, secret, value, or integration.',
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
			let remoteConnectorDownStatuses: Array<RemoteConnectorStatus> = []
			let username: string | null = null

			const searchSpan = async () => {
				const query = args.query?.trim() ?? ''
				username = await resolvePublicUsername({
					db: agent.getEnv().APP_DB,
					username: callerContext.user?.username ?? null,
					email: callerContext.user?.email ?? null,
				})
				const retrieverRunPromise =
					userId && query
						? (async () => {
								try {
									const { runPackageRetrievers } =
										await import('#worker/package-retrievers/service.ts')
									return await runPackageRetrievers({
										env: agent.getEnv(),
										baseUrl,
										userId,
										scope: 'search',
										query,
										memoryContext: resolveSearchMemoryContext({
											query,
											memoryContext: args.memoryContext,
										}),
										conversationId,
									})
								} catch (error) {
									Sentry.captureException(error, {
										tags: {
											scope: 'search.package-retrievers',
										},
									})
									return {
										results: [],
										warnings: [
											'Package retrievers are temporarily unavailable.',
										],
									}
								}
							})()
						: Promise.resolve({ results: [], warnings: [] })
				const [searchRows] = await Promise.all([
					loadSearchRowsAndRegistry({
						agent,
						callerContext,
						userId,
					}),
					retrieverRunPromise,
				])
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
					query: args.query!,
					limit,
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
							retrieverResults: memoryToolContext.retrieverResults,
						}
					: undefined
				if (memoryToolContext) {
					warnings.push(...memoryToolContext.retrieverWarnings)
				}
				const structuredWarnings = [...warnings]

				const payload: {
					matches: Array<SearchMatch>
					offline: boolean
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
				const formattingMs = Math.max(
					0,
					Math.round(performance.now() - formattingStartMs),
				)
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
