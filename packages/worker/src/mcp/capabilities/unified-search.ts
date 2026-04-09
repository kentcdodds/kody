import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
	lexicalScore,
	type CapabilitySearchHit,
	reciprocalRankFusion,
	searchCapabilities,
	sortIdsByScore,
} from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'
import {
	type ConnectorConfig,
	parseConnectorConfig,
	parseConnectorJson,
	parseConnectorValueName,
} from '#mcp/capabilities/values/connector-shared.ts'
import { buildSkillEmbedText } from '#mcp/skills/skill-embed-and-flags.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { parseSkillParameters } from '#mcp/skills/skill-parameters.ts'
import {
	type SecretMetadata,
	type SecretSearchRow,
} from '#mcp/secrets/types.ts'
import { buildValueEntityId, describeValue } from '#mcp/tools/search-entities.ts'
import {
	type UiArtifactSearchHit,
	searchUiArtifactsForUser,
} from '#mcp/ui-artifacts-search.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type ValueMetadata, type ValueScope } from '#mcp/values/types.ts'

function parseJsonStringArray(raw: string): Array<string> {
	try {
		const v = JSON.parse(raw) as unknown
		if (!Array.isArray(v)) return []
		return v.filter((x): x is string => typeof x === 'string')
	} catch {
		return []
	}
}

function buildSkillUsage(skillName: string): string {
	const runArgs = JSON.stringify({ name: skillName })
	return `Run with meta_run_skill: ${runArgs}. Optionally include "params": { ... }. To inspect code, call meta_get_skill then execute.`
}

function normalizeSearchPhrase(value: string | null | undefined): string {
	return (value ?? '')
		.toLowerCase()
		.replace(/[-_]+/g, ' ')
		.replace(/[^a-z0-9\s]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function scoreSkillPhraseMatch(
	normalizedQuery: string,
	value: string | null | undefined,
): number {
	const normalizedValue = normalizeSearchPhrase(value)
	if (!normalizedQuery || !normalizedValue) return 0
	if (normalizedValue === normalizedQuery) return 1.5
	if (normalizedValue.includes(normalizedQuery)) return 1
	return 0
}

function scoreSkillLexicalMatch(
	query: string,
	row: McpSkillRow,
	doc: string,
	keywords: ReadonlyArray<string>,
): number {
	const normalizedQuery = normalizeSearchPhrase(query)
	let bonus = 0

	bonus += scoreSkillPhraseMatch(normalizedQuery, row.name) * 2
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.title) * 1.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.description) * 1.25
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.search_text) * 1
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.collection_name) * 0.25
	for (const keyword of keywords) {
		bonus += scoreSkillPhraseMatch(normalizedQuery, keyword) * 0.5
	}

	return lexicalScore(query, doc) + bonus
}

type ValueLexicalFields = Pick<
	ValueMetadata,
	'name' | 'description' | 'scope' | 'value' | 'appId'
>

function scoreValuePhraseBonus(
	query: string,
	row: ValueLexicalFields,
): number {
	const normalizedQuery = normalizeSearchPhrase(query)
	let bonus = 0
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.name) * 2
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.description) * 1.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.scope) * 0.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.appId) * 0.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, row.value) * 1
	return bonus
}

type ConnectorLexicalFields = {
	connectorName: string
	description: string | null | undefined
	apiBaseUrl: string | null | undefined
	tokenUrl: string | null | undefined
	requiredHosts: ReadonlyArray<string>
}

function scoreConnectorPhraseBonus(
	query: string,
	entry: ConnectorLexicalFields,
): number {
	const normalizedQuery = normalizeSearchPhrase(query)
	let bonus = 0
	bonus += scoreSkillPhraseMatch(normalizedQuery, entry.connectorName) * 2
	bonus += scoreSkillPhraseMatch(normalizedQuery, entry.description) * 1.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, entry.apiBaseUrl) * 1
	bonus += scoreSkillPhraseMatch(normalizedQuery, entry.tokenUrl) * 0.75
	bonus +=
		scoreSkillPhraseMatch(normalizedQuery, entry.requiredHosts.join(' ')) * 0.75
	return bonus
}

function scoreCapabilityLexicalMatch(
	query: string,
	hit: CapabilitySearchHit,
): number {
	const normalizedQuery = normalizeSearchPhrase(query)
	const doc = [hit.name, hit.domain, hit.description].join('\n')
	let bonus = 0
	bonus += scoreSkillPhraseMatch(normalizedQuery, hit.name) * 1.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, hit.description) * 1
	return lexicalScore(query, doc) + bonus
}

function scoreSecretLexicalMatch(query: string, hit: SecretSearchHit): number {
	const normalizedQuery = normalizeSearchPhrase(query)
	const doc = [hit.name, hit.description].join('\n')
	let bonus = 0
	bonus += scoreSkillPhraseMatch(normalizedQuery, hit.name) * 1.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, hit.description) * 1
	return lexicalScore(query, doc) + bonus
}

function scoreUiArtifactLexicalMatch(
	query: string,
	hit: UiArtifactSearchHit,
): number {
	const normalizedQuery = normalizeSearchPhrase(query)
	const parameterText = (hit.parameters ?? [])
		.map((parameter) => `${parameter.name} ${parameter.description}`)
		.join('\n')
	const doc = [hit.title, hit.description, hit.runtime, parameterText].join(
		'\n',
	)
	let bonus = 0
	bonus += scoreSkillPhraseMatch(normalizedQuery, hit.title) * 1.5
	bonus += scoreSkillPhraseMatch(normalizedQuery, hit.description) * 1
	return lexicalScore(query, doc) + bonus
}

function buildValueUsage(name: string, scope: ValueScope): string {
	return `Read with value_get: ${JSON.stringify({ name, scope })}. List related persisted config with value_list${scope === 'user' ? '({ scope: "user" })' : '({ ... })'}.`
}

function scoreValueLexicalMatch(
	query: string,
	row: ValueMetadata,
	doc: string,
): number {
	return lexicalScore(query, doc) + scoreValuePhraseBonus(query, row)
}

function buildValueEmbedDoc(row: ValueMetadata): string {
	return [
		`value ${row.name}`,
		`scope ${row.scope}`,
		row.description,
		row.value,
		row.appId ? `app ${row.appId}` : '',
	].join('\n')
}

function buildConnectorUsage(name: string): string {
	return `Read with connector_get: ${JSON.stringify({ name })}. Browse saved connector configs with connector_list({}).`
}

function describeConnector(
	config: ConnectorConfig,
	description: string | null | undefined,
): string {
	const trimmed = description?.trim()
	if (trimmed) return trimmed
	return `Saved OAuth connector configuration (${config.flow} flow).`
}

function scoreConnectorLexicalMatch(
	query: string,
	entry: ConnectorSearchEntry,
	doc: string,
): number {
	return (
		lexicalScore(query, doc) +
		scoreConnectorPhraseBonus(query, {
			connectorName: entry.config.name,
			description: describeConnector(entry.config, entry.row.description),
			apiBaseUrl: entry.config.apiBaseUrl,
			tokenUrl: entry.config.tokenUrl,
			requiredHosts: entry.config.requiredHosts ?? [],
		})
	)
}

function buildConnectorEmbedDoc(entry: ConnectorSearchEntry): string {
	const requiredHosts = entry.config.requiredHosts ?? []
	return [
		`connector ${entry.config.name}`,
		describeConnector(entry.config, entry.row.description),
		entry.config.flow,
		entry.config.tokenUrl,
		entry.config.apiBaseUrl ?? '',
		entry.config.clientIdValueName,
		entry.config.clientSecretSecretName ?? '',
		entry.config.accessTokenSecretName,
		entry.config.refreshTokenSecretName ?? '',
		requiredHosts.join('\n'),
	].join('\n')
}

function skillRowEmbedDoc(
	row: McpSkillRow,
	specs: Record<string, CapabilitySpec>,
): string {
	const keywords = parseJsonStringArray(row.keywords)
	const parameters = parseSkillParameters(row.parameters)
	let inferred: Array<string> = []
	try {
		const v = JSON.parse(row.inferred_capabilities) as unknown
		if (Array.isArray(v)) {
			inferred = v.filter((x): x is string => typeof x === 'string')
		}
	} catch {
		inferred = []
	}
	return buildSkillEmbedText({
		skillName: row.name,
		title: row.title,
		description: row.description,
		collectionName: row.collection_name,
		collectionSlug: row.collection_slug,
		keywords,
		searchText: row.search_text,
		inferredCapabilities: inferred,
		parameters,
		specs,
	})
}

export type SkillSearchHitSummary = {
	type: 'skill'
	skillName: string
	domain: 'meta'
	collection: string | null
	collectionSlug: string | null
	title: string
	description: string
	keywords: Array<string>
	usage: string
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	inferencePartial: boolean
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
}

export type SkillSearchHit = SkillSearchHitSummary

export type CapabilitySearchHitTyped = {
	type: 'capability'
} & CapabilitySearchHit

export type SecretSearchHitSummary = {
	type: 'secret'
	scope: 'user'
	name: string
	description: string
	usage: string
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
}

export type SecretSearchHit = SecretSearchHitSummary

export type ValueSearchHitSummary = {
	type: 'value'
	valueId: string
	name: string
	scope: ValueScope
	description: string
	value: string
	appId: string | null
	updatedAt: string
	ttlMs: number | null
	usage: string
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
}

export type ValueSearchHit = ValueSearchHitSummary

type ConnectorSearchEntry = {
	connectorId: string
	row: ValueMetadata
	config: ConnectorConfig
}

export type ConnectorSearchHitSummary = {
	type: 'connector'
	connectorName: string
	title: string
	description: string
	flow: ConnectorConfig['flow']
	tokenUrl: string
	apiBaseUrl: string | null
	clientIdValueName: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string | null
	requiredHosts: Array<string>
	usage: string
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
}

export type ConnectorSearchHit = ConnectorSearchHitSummary

export type UnifiedSearchMatch =
	| CapabilitySearchHitTyped
	| SkillSearchHit
	| SecretSearchHit
	| ValueSearchHit
	| ConnectorSearchHit
	| UiArtifactSearchHit

function buildSecretUsage(name: string) {
	return `Use in execute-time fetch placeholders like {{secret:${name}|scope=user}} and ask the user to approve each destination host in the app when needed. Only place placeholders in fetch URL/header/body fields or x-kody-secret capability inputs; do not copy them into visible content such as prompts, comments, issue bodies, logs, or returned strings.`
}

function rowToSecretHit(
	row: SecretSearchRow,
	fusedScore: number,
	lexicalRank?: number,
	vectorRank?: number,
): SecretSearchHit {
	return {
		type: 'secret',
		scope: 'user',
		name: row.name,
		description: row.description,
		usage: buildSecretUsage(row.name),
		fusedScore,
		lexicalRank,
		vectorRank,
	}
}

function rowToValueHit(
	row: ValueMetadata,
	fusedScore: number,
	lexicalRank?: number,
	vectorRank?: number,
): ValueSearchHit {
	return {
		type: 'value',
		valueId: buildValueEntityId(row),
		name: row.name,
		scope: row.scope,
		description: describeValue(row),
		value: row.value,
		appId: row.appId,
		updatedAt: row.updatedAt,
		ttlMs: row.ttlMs,
		usage: buildValueUsage(row.name, row.scope),
		fusedScore,
		lexicalRank,
		vectorRank,
	}
}

function rowToConnectorHit(
	entry: ConnectorSearchEntry,
	fusedScore: number,
	lexicalRank?: number,
	vectorRank?: number,
): ConnectorSearchHit {
	return {
		type: 'connector',
		connectorName: entry.connectorId,
		title: entry.connectorId,
		description: describeConnector(entry.config, entry.row.description),
		flow: entry.config.flow,
		tokenUrl: entry.config.tokenUrl,
		apiBaseUrl: entry.config.apiBaseUrl ?? null,
		clientIdValueName: entry.config.clientIdValueName,
		clientSecretSecretName: entry.config.clientSecretSecretName ?? null,
		accessTokenSecretName: entry.config.accessTokenSecretName,
		refreshTokenSecretName: entry.config.refreshTokenSecretName ?? null,
		requiredHosts: entry.config.requiredHosts ?? [],
		usage: buildConnectorUsage(entry.connectorId),
		fusedScore,
		lexicalRank,
		vectorRank,
	}
}

function rowToSkillHit(
	row: McpSkillRow,
	fusedScore: number,
	lexicalRank?: number,
	vectorRank?: number,
): SkillSearchHit {
	const keywords = parseJsonStringArray(row.keywords)
	return {
		type: 'skill',
		skillName: row.name,
		domain: 'meta',
		collection: row.collection_name,
		collectionSlug: row.collection_slug,
		title: row.title,
		description: row.description,
		keywords,
		usage: buildSkillUsage(row.name),
		readOnly: row.read_only === 1,
		idempotent: row.idempotent === 1,
		destructive: row.destructive === 1,
		inferencePartial: row.inference_partial === 1,
		fusedScore,
		lexicalRank,
		vectorRank,
	}
}

async function searchSkillsForUser(input: {
	env: Env
	query: string
	limit: number
	specs: Record<string, CapabilitySpec>
	userId: string
	rows: Array<McpSkillRow>
	collectionSlug?: string | null
}): Promise<{ matches: Array<SkillSearchHit>; offline: boolean }> {
	const q = input.query.trim()
	const filteredRows =
		input.collectionSlug == null
			? input.rows
			: input.rows.filter((row) => row.collection_slug === input.collectionSlug)
	const idSet = new Map(filteredRows.map((r) => [r.id, r] as const))
	const ids = [...idSet.keys()]
	const offline = isCapabilitySearchOffline(input.env)

	if (ids.length === 0) {
		return { matches: [], offline }
	}

	const docsById = Object.fromEntries(
		filteredRows.map(
			(row) => [row.id, skillRowEmbedDoc(row, input.specs)] as const,
		),
	)
	const keywordsById = Object.fromEntries(
		filteredRows.map(
			(row) => [row.id, parseJsonStringArray(row.keywords)] as const,
		),
	)
	const lexicalScoreById = Object.fromEntries(
		ids.map((id) => {
			const row = idSet.get(id)!
			return [
				id,
				scoreSkillLexicalMatch(q, row, docsById[id]!, keywordsById[id] ?? []),
			] as const
		}),
	)

	const lexicalOrder = sortIdsByScore(ids, (id) => lexicalScoreById[id]!)

	let vectorOrder: Array<string>

	if (offline) {
		const qVec = deterministicEmbedding(q)
		const simById = Object.fromEntries(
			ids.map((id) => {
				const cVec = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(qVec, cVec)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => simById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const qVec = await embedTextForVectorize(input.env, q)
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)
		const rowById = idSet

		async function collectSkillOrder(
			filter?: VectorizeVectorMetadataFilter,
		): Promise<Array<string>> {
			const matches = await index.query(qVec, {
				topK,
				returnMetadata: 'none',
				...(filter ? { filter } : {}),
			})
			const seenVec = new Set<string>()
			const order: Array<string> = []
			for (const m of matches.matches) {
				if (typeof m.id !== 'string' || seenVec.has(m.id)) continue
				if (!m.id.startsWith('skill_')) continue
				const skillId = m.id.slice('skill_'.length)
				const row = rowById.get(skillId)
				if (!row || row.user_id !== input.userId) continue
				seenVec.add(m.id)
				order.push(skillId)
			}
			return order
		}

		let fromIndex = await collectSkillOrder({
			kind: { $eq: 'skill' },
			userId: { $eq: input.userId },
			...(input.collectionSlug
				? { collectionSlug: { $eq: input.collectionSlug } }
				: {}),
		})
		if (fromIndex.length === 0) {
			fromIndex = await collectSkillOrder({
				kind: { $eq: 'skill' },
				userId: { $eq: input.userId },
			})
		}
		const seenSkillIds = new Set(fromIndex)
		vectorOrder = [...fromIndex, ...ids.filter((id) => !seenSkillIds.has(id))]
	}

	const lexicalRankById = new Map<string, number>()
	for (let r = 0; r < lexicalOrder.length; r += 1) {
		lexicalRankById.set(lexicalOrder[r]!, r + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let r = 0; r < vectorOrder.length; r += 1) {
		vectorRankById.set(vectorOrder[r]!, r + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = [...ids]
		.sort((a, b) => {
			const fusedDiff = (fused.get(b) ?? 0) - (fused.get(a) ?? 0)
			if (fusedDiff !== 0) return fusedDiff
			const lexicalDiff = lexicalScoreById[b]! - lexicalScoreById[a]!
			if (lexicalDiff !== 0) return lexicalDiff
			return (
				(vectorRankById.get(a) ?? Number.MAX_SAFE_INTEGER) -
				(vectorRankById.get(b) ?? Number.MAX_SAFE_INTEGER)
			)
		})
		.slice(0, Math.max(1, Math.min(input.limit, ids.length)))

	const matches = ordered.map((id) => {
		const row = idSet.get(id)!
		return rowToSkillHit(
			row,
			fused.get(id) ?? 0,
			lexicalRankById.get(id),
			vectorRankById.get(id),
		)
	})

	return { matches, offline }
}

async function searchSecretsForUser(input: {
	query: string
	limit: number
	rows: Array<SecretSearchRow>
}): Promise<{ matches: Array<SecretSearchHit>; offline: boolean }> {
	const rowsByName = new Map(input.rows.map((row) => [row.name, row] as const))
	const names = [...rowsByName.keys()]
	if (names.length === 0) {
		return { matches: [], offline: false }
	}

	const docsByName = Object.fromEntries(
		input.rows.map(
			(row) =>
				[
					row.name,
					`${row.name}\n${row.description}\nsecret scope: user`,
				] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(names, (name) =>
		lexicalScore(input.query, docsByName[name]!),
	)
	const queryVector = deterministicEmbedding(input.query)
	const vectorOrder = sortIdsByScore(names, (name) =>
		cosineSimilarity(queryVector, deterministicEmbedding(docsByName[name]!)),
	)

	const lexicalRankByName = new Map<string, number>()
	for (let index = 0; index < lexicalOrder.length; index += 1) {
		lexicalRankByName.set(lexicalOrder[index]!, index + 1)
	}
	const vectorRankByName = new Map<string, number>()
	for (let index = 0; index < vectorOrder.length; index += 1) {
		vectorRankByName.set(vectorOrder[index]!, index + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = sortIdsByScore(names, (name) => fused.get(name) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, names.length)),
	)

	return {
		matches: ordered.map((name) =>
			rowToSecretHit(
				rowsByName.get(name)!,
				fused.get(name) ?? 0,
				lexicalRankByName.get(name),
				vectorRankByName.get(name),
			),
		),
		offline: false,
	}
}

async function searchValuesForUser(input: {
	query: string
	limit: number
	rows: Array<ValueMetadata>
}): Promise<{ matches: Array<ValueSearchHit>; offline: boolean }> {
	const rowsById = new Map(
		input.rows
			.filter((row) => parseConnectorValueName(row.name) == null)
			.map((row) => [buildValueEntityId(row), row] as const),
	)
	const ids = [...rowsById.keys()]
	if (ids.length === 0) {
		return { matches: [], offline: false }
	}

	const docsById = Object.fromEntries(
		[...rowsById.values()].map(
			(row) => [buildValueEntityId(row), buildValueEmbedDoc(row)] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(ids, (id) =>
		scoreValueLexicalMatch(input.query, rowsById.get(id)!, docsById[id]!),
	)
	const queryVector = deterministicEmbedding(input.query)
	const vectorOrder = sortIdsByScore(ids, (id) =>
		cosineSimilarity(queryVector, deterministicEmbedding(docsById[id]!)),
	)

	const lexicalRankById = new Map<string, number>()
	for (let index = 0; index < lexicalOrder.length; index += 1) {
		lexicalRankById.set(lexicalOrder[index]!, index + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let index = 0; index < vectorOrder.length; index += 1) {
		vectorRankById.set(vectorOrder[index]!, index + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = sortIdsByScore(ids, (id) => fused.get(id) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, ids.length)),
	)

	return {
		matches: ordered.map((id) =>
			rowToValueHit(
				rowsById.get(id)!,
				fused.get(id) ?? 0,
				lexicalRankById.get(id),
				vectorRankById.get(id),
			),
		),
		offline: false,
	}
}

async function searchConnectorsForUser(input: {
	query: string
	limit: number
	rows: Array<ValueMetadata>
}): Promise<{ matches: Array<ConnectorSearchHit>; offline: boolean }> {
	const entries = input.rows
		.map((row) => {
			const connectorName = parseConnectorValueName(row.name)
			if (!connectorName) return null
			const config = parseConnectorConfig(
				parseConnectorJson(row.value),
				connectorName,
			)
			if (!config) return null
			if (config.name !== connectorName) return null
			return {
				connectorId: connectorName,
				row,
				config,
			} satisfies ConnectorSearchEntry
		})
		.filter((entry): entry is ConnectorSearchEntry => entry != null)
	const entryById = new Map(
		entries.map((entry) => [entry.connectorId, entry] as const),
	)
	const ids = [...entryById.keys()]
	if (ids.length === 0) {
		return { matches: [], offline: false }
	}

	const docsById = Object.fromEntries(
		entries.map(
			(entry) => [entry.connectorId, buildConnectorEmbedDoc(entry)] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(ids, (id) =>
		scoreConnectorLexicalMatch(input.query, entryById.get(id)!, docsById[id]!),
	)
	const queryVector = deterministicEmbedding(input.query)
	const vectorOrder = sortIdsByScore(ids, (id) =>
		cosineSimilarity(queryVector, deterministicEmbedding(docsById[id]!)),
	)

	const lexicalRankById = new Map<string, number>()
	for (let index = 0; index < lexicalOrder.length; index += 1) {
		lexicalRankById.set(lexicalOrder[index]!, index + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let index = 0; index < vectorOrder.length; index += 1) {
		vectorRankById.set(vectorOrder[index]!, index + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = sortIdsByScore(ids, (id) => fused.get(id) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, ids.length)),
	)

	return {
		matches: ordered.map((id) =>
			rowToConnectorHit(
				entryById.get(id)!,
				fused.get(id) ?? 0,
				lexicalRankById.get(id),
				vectorRankById.get(id),
			),
		),
		offline: false,
	}
}

export async function searchUnified(input: {
	env: Env
	baseUrl: string
	query: string
	limit: number
	specs: Record<string, CapabilitySpec>
	userId: string | null
	skillCollectionSlug?: string | null
	skillRows: Array<McpSkillRow>
	uiArtifactRows: Array<UiArtifactRow>
	userSecretRows: Array<SecretSearchRow>
	userValueRows: Array<ValueMetadata>
	appSecretsByAppId: Map<string, Array<SecretMetadata>>
}): Promise<{ matches: Array<UnifiedSearchMatch>; offline: boolean }> {
	const builtinFilter: VectorizeVectorMetadataFilter = {
		kind: { $eq: 'builtin' },
	}
	const candidateLimit = Math.min(100, Math.max(input.limit * 3, 25))
	const offlineByEnv = isCapabilitySearchOffline(input.env)
	const capResultPromise = searchCapabilities({
		env: input.env,
		query: input.query,
		limit: candidateLimit,
		detail: false,
		specs: input.specs,
		vectorMetadataFilter: offlineByEnv ? undefined : builtinFilter,
	})
	let capResult: Awaited<ReturnType<typeof searchCapabilities>> = {
		matches: [],
		offline: offlineByEnv,
	}

	let skillResult: { matches: Array<SkillSearchHit>; offline: boolean } = {
		matches: [],
		offline: offlineByEnv,
	}
	let uiArtifactResult: {
		matches: Array<UiArtifactSearchHit>
		offline: boolean
	} = {
		matches: [],
		offline: offlineByEnv,
	}
	let secretResult: {
		matches: Array<SecretSearchHit>
		offline: boolean
	} = {
		matches: [],
		offline: false,
	}
	let valueResult: {
		matches: Array<ValueSearchHit>
		offline: boolean
	} = {
		matches: [],
		offline: false,
	}
	let connectorResult: {
		matches: Array<ConnectorSearchHit>
		offline: boolean
	} = {
		matches: [],
		offline: false,
	}
	if (input.userId) {
		;[
			capResult,
			secretResult,
			valueResult,
			connectorResult,
			skillResult,
			uiArtifactResult,
		] = await Promise.all([
			capResultPromise,
			searchSecretsForUser({
				query: input.query,
				limit: candidateLimit,
				rows: input.userSecretRows,
			}),
			searchValuesForUser({
				query: input.query,
				limit: candidateLimit,
				rows: input.userValueRows,
			}),
			searchConnectorsForUser({
				query: input.query,
				limit: candidateLimit,
				rows: input.userValueRows,
			}),
			searchSkillsForUser({
				env: input.env,
				query: input.query,
				limit: candidateLimit,
				specs: input.specs,
				userId: input.userId,
				collectionSlug: input.skillCollectionSlug,
				rows: input.skillRows,
			}),
			searchUiArtifactsForUser({
				baseUrl: input.baseUrl,
				env: input.env,
				query: input.query,
				limit: candidateLimit,
				userId: input.userId,
				rows: input.uiArtifactRows,
				appSecretsByAppId: input.appSecretsByAppId,
			}),
		])
	} else {
		capResult = await capResultPromise
	}

	const capByName = new Map(capResult.matches.map((m) => [m.name, m] as const))
	const skillByName = new Map(
		skillResult.matches.map((m) => [m.skillName, m] as const),
	)
	const secretByName = new Map(
		secretResult.matches.map((m) => [m.name, m] as const),
	)
	const valueById = new Map(
		valueResult.matches.map((m) => [m.valueId, m] as const),
	)
	const connectorByName = new Map(
		connectorResult.matches.map((m) => [m.connectorName, m] as const),
	)
	const uiArtifactById = new Map(
		uiArtifactResult.matches.map((m) => [m.appId, m] as const),
	)
	const capKeys = capResult.matches.map((m) => `c:${m.name}`)
	const skillKeys = skillResult.matches.map((m) => `s:${m.skillName}`)
	const secretKeys = secretResult.matches.map((m) => `u:${m.name}`)
	const valueKeys = valueResult.matches.map((m) => `v:${m.valueId}`)
	const connectorKeys = connectorResult.matches.map(
		(m) => `n:${m.connectorName}`,
	)
	const uiArtifactKeys = uiArtifactResult.matches.map((m) => `a:${m.appId}`)
	const fusedCross = reciprocalRankFusion(
		[capKeys, skillKeys, secretKeys, valueKeys, connectorKeys, uiArtifactKeys],
		CAPABILITY_SEARCH_RRF_K,
	)
	const allKeys = [
		...new Set([
			...capKeys,
			...skillKeys,
			...secretKeys,
			...valueKeys,
			...connectorKeys,
			...uiArtifactKeys,
		]),
	]
	function getEntityScore(key: string): number {
		if (key.startsWith('n:')) {
			return connectorByName.get(key.slice(2))?.fusedScore ?? 0
		}
		if (key.startsWith('c:')) {
			return capByName.get(key.slice(2))?.fusedScore ?? 0
		}
		if (key.startsWith('s:')) {
			return skillByName.get(key.slice(2))?.fusedScore ?? 0
		}
		if (key.startsWith('u:')) {
			return secretByName.get(key.slice(2))?.fusedScore ?? 0
		}
		if (key.startsWith('v:')) {
			return valueById.get(key.slice(2))?.fusedScore ?? 0
		}
		if (key.startsWith('a:')) {
			return uiArtifactById.get(key.slice(2))?.fusedScore ?? 0
		}
		return 0
	}
	function getUnifiedLexicalScore(key: string): number {
		if (key.startsWith('n:')) {
			const hit = connectorByName.get(key.slice(2))
			if (!hit) return 0
			const doc = [
				hit.connectorName,
				hit.description,
				hit.flow,
				hit.tokenUrl,
				hit.apiBaseUrl ?? '',
				hit.requiredHosts.join(' '),
			].join('\n')
			return (
				lexicalScore(input.query, doc) +
				scoreConnectorPhraseBonus(input.query, {
					connectorName: hit.connectorName,
					description: hit.description,
					apiBaseUrl: hit.apiBaseUrl,
					tokenUrl: hit.tokenUrl,
					requiredHosts: hit.requiredHosts,
				})
			)
		}
		if (key.startsWith('c:')) {
			const hit = capByName.get(key.slice(2))
			return hit ? scoreCapabilityLexicalMatch(input.query, hit) : 0
		}
		if (key.startsWith('s:')) {
			const hit = skillByName.get(key.slice(2))
			if (!hit) return 0
			return (
				lexicalScore(
					input.query,
					[
						hit.skillName,
						hit.title,
						hit.description,
						hit.collection ?? '',
						hit.keywords.join(' '),
					].join('\n'),
				) +
				scoreSkillPhraseMatch(
					normalizeSearchPhrase(input.query),
					hit.skillName,
				) *
					2 +
				scoreSkillPhraseMatch(normalizeSearchPhrase(input.query), hit.title) *
					1.5 +
				scoreSkillPhraseMatch(
					normalizeSearchPhrase(input.query),
					hit.description,
				) *
					1.25
			)
		}
		if (key.startsWith('u:')) {
			const hit = secretByName.get(key.slice(2))
			return hit ? scoreSecretLexicalMatch(input.query, hit) : 0
		}
		if (key.startsWith('v:')) {
			const hit = valueById.get(key.slice(2))
			if (!hit) return 0
			const doc = [hit.name, hit.description, hit.scope, hit.value, hit.appId ?? '']
				.join('\n')
			return lexicalScore(input.query, doc) + scoreValuePhraseBonus(input.query, hit)
		}
		if (key.startsWith('a:')) {
			const hit = uiArtifactById.get(key.slice(2))
			return hit ? scoreUiArtifactLexicalMatch(input.query, hit) : 0
		}
		return 0
	}
	const lexicalScoreByKey = new Map(
		allKeys.map((key) => [key, getUnifiedLexicalScore(key)] as const),
	)
	const sortedKeys = [...allKeys]
		.sort((a, b) => {
			const fusedDiff = (fusedCross.get(b) ?? 0) - (fusedCross.get(a) ?? 0)
			if (fusedDiff !== 0) return fusedDiff
			const lexicalDiff =
				(lexicalScoreByKey.get(b) ?? 0) - (lexicalScoreByKey.get(a) ?? 0)
			if (lexicalDiff !== 0) return lexicalDiff
			const entityDiff = getEntityScore(b) - getEntityScore(a)
			if (entityDiff !== 0) return entityDiff
			return a.localeCompare(b)
		})
		.slice(0, Math.max(1, input.limit))

	const matches: Array<UnifiedSearchMatch> = []
	for (const key of sortedKeys) {
		const score = fusedCross.get(key) ?? 0
		if (key.startsWith('c:')) {
			const name = key.slice(2)
			const hit = capByName.get(name)
			if (hit) {
				matches.push({ type: 'capability', ...hit, fusedScore: score })
			}
		} else if (key.startsWith('s:')) {
			const name = key.slice(2)
			const hit = skillByName.get(name)
			if (hit) {
				matches.push({ ...hit, fusedScore: score })
			}
		} else if (key.startsWith('u:')) {
			const name = key.slice(2)
			const hit = secretByName.get(name)
			if (hit) {
				matches.push({ ...hit, fusedScore: score })
			}
		} else if (key.startsWith('v:')) {
			const id = key.slice(2)
			const hit = valueById.get(id)
			if (hit) {
				matches.push({ ...hit, fusedScore: score })
			}
		} else if (key.startsWith('n:')) {
			const name = key.slice(2)
			const hit = connectorByName.get(name)
			if (hit) {
				matches.push({ ...hit, fusedScore: score })
			}
		} else if (key.startsWith('a:')) {
			const id = key.slice(2)
			const hit = uiArtifactById.get(id)
			if (hit) {
				matches.push({ ...hit, fusedScore: score })
			}
		}
	}

	const offline =
		capResult.offline ||
		skillResult.offline ||
		secretResult.offline ||
		valueResult.offline ||
		connectorResult.offline ||
		uiArtifactResult.offline
	return { matches, offline }
}
