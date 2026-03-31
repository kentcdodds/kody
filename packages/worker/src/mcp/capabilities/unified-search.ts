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
import { buildSkillEmbedText } from '#mcp/skills/skill-embed-and-flags.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import {
	parseSkillParameters,
	type SkillParameterDefinition,
} from '#mcp/skills/skill-parameters.ts'
import {
	type SecretMetadata,
	type SecretSearchRow,
} from '#mcp/secrets/types.ts'
import {
	type UiArtifactSearchHit,
	searchUiArtifactsForUser,
} from '#mcp/ui-artifacts-search.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'

function parseJsonStringArray(raw: string): Array<string> {
	try {
		const v = JSON.parse(raw) as unknown
		if (!Array.isArray(v)) return []
		return v.filter((x): x is string => typeof x === 'string')
	} catch {
		return []
	}
}

function buildSkillUsage(skillId: string): string {
	const runArgs = JSON.stringify({ skill_id: skillId })
	return `Run with meta_run_skill: ${runArgs}. Optionally include "params": { ... }. To inspect code, call meta_get_skill then execute.`
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
	skillId: string
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

export type SkillSearchHitDetail = SkillSearchHitSummary & {
	inferredCapabilities: Array<string>
	usesCapabilities: Array<string> | null
	searchText: string | null
	parameters: Array<SkillParameterDefinition> | null
}

export type SkillSearchHit = SkillSearchHitSummary | SkillSearchHitDetail

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

export type UnifiedSearchMatch =
	| CapabilitySearchHitTyped
	| SkillSearchHit
	| SecretSearchHit
	| UiArtifactSearchHit

function buildSecretUsage(name: string) {
	return `Use in execute-time fetch placeholders like {{secret:${name}|scope=user}} and ask the user to approve each destination host in the app when needed.`
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

function rowToSkillHit(
	row: McpSkillRow,
	fusedScore: number,
	lexicalRank?: number,
	vectorRank?: number,
): SkillSearchHit {
	const keywords = parseJsonStringArray(row.keywords)
	return {
		type: 'skill',
		skillId: row.id,
		domain: 'meta',
		collection: row.collection_name,
		collectionSlug: row.collection_slug,
		title: row.title,
		description: row.description,
		keywords,
		usage: buildSkillUsage(row.id),
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

	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(q, docsById[id]!),
	)

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
	const ordered = sortIdsByScore(ids, (id) => fused.get(id) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, ids.length)),
	)

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
	appSecretsByAppId: Map<string, Array<SecretMetadata>>
}): Promise<{ matches: Array<UnifiedSearchMatch>; offline: boolean }> {
	const builtinFilter: VectorizeVectorMetadataFilter = {
		kind: { $eq: 'builtin' },
	}
	const capResult = await searchCapabilities({
		env: input.env,
		query: input.query,
		limit: input.limit,
		detail: false,
		specs: input.specs,
		vectorMetadataFilter: isCapabilitySearchOffline(input.env)
			? undefined
			: builtinFilter,
	})

	let skillResult: { matches: Array<SkillSearchHit>; offline: boolean } = {
		matches: [],
		offline: capResult.offline,
	}
	let uiArtifactResult: {
		matches: Array<UiArtifactSearchHit>
		offline: boolean
	} = {
		matches: [],
		offline: capResult.offline,
	}
	let secretResult: {
		matches: Array<SecretSearchHit>
		offline: boolean
	} = {
		matches: [],
		offline: false,
	}
	if (input.userId) {
		secretResult = await searchSecretsForUser({
			query: input.query,
			limit: input.limit,
			rows: input.userSecretRows,
		})
		skillResult = await searchSkillsForUser({
			env: input.env,
			query: input.query,
			limit: input.limit,
			specs: input.specs,
			userId: input.userId,
			collectionSlug: input.skillCollectionSlug,
			rows: input.skillRows,
		})
		uiArtifactResult = await searchUiArtifactsForUser({
			baseUrl: input.baseUrl,
			env: input.env,
			query: input.query,
			limit: input.limit,
			userId: input.userId,
			rows: input.uiArtifactRows,
			appSecretsByAppId: input.appSecretsByAppId,
		})
	}

	const capKeys = capResult.matches.map((m) => `c:${m.name}`)
	const skillKeys = skillResult.matches.map((m) => `s:${m.skillId}`)
	const secretKeys = secretResult.matches.map((m) => `u:${m.name}`)
	const uiArtifactKeys = uiArtifactResult.matches.map((m) => `a:${m.appId}`)
	const fusedCross = reciprocalRankFusion(
		[capKeys, skillKeys, secretKeys, uiArtifactKeys],
		CAPABILITY_SEARCH_RRF_K,
	)
	const allKeys = [
		...new Set([...capKeys, ...skillKeys, ...secretKeys, ...uiArtifactKeys]),
	]
	const sortedKeys = sortIdsByScore(
		allKeys,
		(k) => fusedCross.get(k) ?? 0,
	).slice(0, Math.max(1, input.limit))

	const capByName = new Map(capResult.matches.map((m) => [m.name, m] as const))
	const skillById = new Map(
		skillResult.matches.map((m) => [m.skillId, m] as const),
	)
	const secretByName = new Map(
		secretResult.matches.map((m) => [m.name, m] as const),
	)
	const uiArtifactById = new Map(
		uiArtifactResult.matches.map((m) => [m.appId, m] as const),
	)

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
			const id = key.slice(2)
			const hit = skillById.get(id)
			if (hit) {
				matches.push({ ...hit, fusedScore: score })
			}
		} else if (key.startsWith('u:')) {
			const name = key.slice(2)
			const hit = secretByName.get(name)
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
		uiArtifactResult.offline
	return { matches, offline }
}
