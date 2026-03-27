import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
} from '#mcp/capabilities/capability-search.ts'
import { type SecretMetadata } from '#mcp/secrets/types.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import { type UiArtifactRow } from './ui-artifacts-types.ts'

function parseJsonStringArray(raw: string): Array<string> {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return value.filter((item): item is string => typeof item === 'string')
	} catch {
		return []
	}
}

function rowToEmbedDoc(row: UiArtifactRow, appSecrets: Array<SecretMetadata>) {
	const secretText =
		appSecrets.length > 0
			? `\nAvailable app secrets:\n${appSecrets
					.map((secret) => `${secret.name}: ${secret.description}`)
					.join('\n')}`
			: ''
	return `${buildUiArtifactEmbedText({
		title: row.title,
		description: row.description,
		keywords: parseJsonStringArray(row.keywords),
		searchText: row.search_text,
		runtime: row.runtime,
		parameters: parseUiArtifactParameters(row.parameters),
	})}${secretText}`
}

function buildUsage(row: UiArtifactRow) {
	const parameters = parseUiArtifactParameters(row.parameters)
	const usageArgs: Record<string, unknown> = { app_id: row.id }
	if (parameters && parameters.length > 0) {
		usageArgs['params'] = Object.fromEntries(
			parameters.map((parameter) => [
				parameter.name,
				parameter.default ?? `<${parameter.type}>`,
			]),
		)
	}
	return `Open with open_generated_ui: ${JSON.stringify(usageArgs)}.`
}

export type UiArtifactSearchHitSummary = {
	type: 'app'
	appId: string
	domain: 'apps'
	title: string
	description: string
	keywords: Array<string>
	runtime: string
	parameters: Array<{
		name: string
		description: string
		type: 'string' | 'number' | 'boolean' | 'json'
		required: boolean
		default?: unknown
	}> | null
	usage: string
	availableSecrets: Array<{
		name: string
		description: string
	}>
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
}

export type UiArtifactSearchHitDetail = UiArtifactSearchHitSummary & {
	searchText: string | null
	createdAt: string
	updatedAt: string
}

export type UiArtifactSearchHit =
	| UiArtifactSearchHitSummary
	| UiArtifactSearchHitDetail

function rowToUiArtifactHit(
	row: UiArtifactRow,
	detail: boolean,
	fusedScore: number,
	lexicalRank?: number,
	vectorRank?: number,
	appSecrets: Array<SecretMetadata> = [],
): UiArtifactSearchHit {
	const parameters = parseUiArtifactParameters(row.parameters)
	const base: UiArtifactSearchHitSummary = {
		type: 'app',
		appId: row.id,
		domain: 'apps',
		title: row.title,
		description: row.description,
		keywords: parseJsonStringArray(row.keywords),
		runtime: row.runtime,
		parameters,
		usage: buildUsage(row),
		availableSecrets: appSecrets.map((secret) => ({
			name: secret.name,
			description: secret.description,
		})),
		fusedScore,
		lexicalRank,
		vectorRank,
	}
	if (detail) {
		return {
			...base,
			searchText: row.search_text,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}
	}
	return base
}

export async function searchUiArtifactsForUser(input: {
	env: Env
	query: string
	limit: number
	detail: boolean
	userId: string
	rows: Array<UiArtifactRow>
	appSecretsByAppId?: Map<string, Array<SecretMetadata>>
}): Promise<{ matches: Array<UiArtifactSearchHit>; offline: boolean }> {
	const query = input.query.trim()
	const rowById = new Map(input.rows.map((row) => [row.id, row] as const))
	const ids = [...rowById.keys()]
	const offline = isCapabilitySearchOffline(input.env)

	if (ids.length === 0) {
		return { matches: [], offline }
	}

	const docsById = Object.fromEntries(
		input.rows.map(
			(row) =>
				[
					row.id,
					rowToEmbedDoc(row, input.appSecretsByAppId?.get(row.id) ?? []),
				] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(query, docsById[id]!),
	)

	let vectorOrder: Array<string>
	if (offline) {
		const queryVector = deterministicEmbedding(query)
		const similarityById = Object.fromEntries(
			ids.map((id) => {
				const rowVector = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(queryVector, rowVector)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => similarityById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const queryVector = await embedTextForVectorize(input.env, query)
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)

		async function collectArtifactOrder(
			filter?: VectorizeVectorMetadataFilter,
		): Promise<Array<string>> {
			const matches = await index.query(queryVector, {
				topK,
				returnMetadata: 'none',
				...(filter ? { filter } : {}),
			})
			const seen = new Set<string>()
			const order: Array<string> = []
			for (const match of matches.matches) {
				if (typeof match.id !== 'string' || seen.has(match.id)) continue
				if (!match.id.startsWith('ui_artifact_')) continue
				const appId = match.id.slice('ui_artifact_'.length)
				const row = rowById.get(appId)
				if (!row || row.user_id !== input.userId) continue
				seen.add(match.id)
				order.push(appId)
			}
			return order
		}

		let fromIndex = await collectArtifactOrder({
			kind: { $eq: 'ui_artifact' },
			userId: { $eq: input.userId },
		})
		if (fromIndex.length === 0) {
			fromIndex = await collectArtifactOrder(undefined)
		}
		const seenIds = new Set(fromIndex)
		vectorOrder = [...fromIndex, ...ids.filter((id) => !seenIds.has(id))]
	}

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
			rowToUiArtifactHit(
				rowById.get(id)!,
				input.detail,
				fused.get(id) ?? 0,
				lexicalRankById.get(id),
				vectorRankById.get(id),
				input.appSecretsByAppId?.get(id) ?? [],
			),
		),
		offline,
	}
}
