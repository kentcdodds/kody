import {
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
} from '#worker/vectorize/embedding.ts'
import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
} from '#worker/vectorize/scoring.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import {
	buildPackageSearchDocument,
	buildPackageSearchProjection,
	type PackageSearchProjection,
} from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { buildPackageReadmeIntent } from '#worker/package-registry/package-readme.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'

import { maxFusedPackageCandidates } from '../search-constants.ts'
import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from '../markdown-safety.ts'
import {
	buildEntityRef,
	buildPackageActionImportUsage,
	buildPackageHostedUrl,
	buildPackageMaintainSnippets,
	buildPackageRootImportUsage,
	getPrimaryPackageActionFunction,
} from '../search-format-helpers.ts'
import { type SearchMatch } from '../search-format-types.ts'
import {
	buildCandidateBaseScore,
	scoreMatchedTerms,
} from '../search-scoring.ts'
import { type PackageSearchRow } from '../search-types.ts'
import { extractMeaningfulSearchTokens } from '../understand-search-query.ts'

export function flattenReferencedTypeFields(
	referencedTypes:
		| ReadonlyArray<{ name: string; definition: string }>
		| undefined,
): Array<string> {
	return (referencedTypes ?? []).flatMap((referencedType) => [
		referencedType.name,
		referencedType.definition,
	])
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
}) {
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
			}
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
		namespace: userVectorNamespace(input.userId),
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

export const packageSearchEntityPlugin = {
	type: 'package',
	candidateTimingKey: 'packageCandidatesMs',
	buildDescriptors(input) {
		return input.optionalRows.packageRows.map((entry) => {
			const services = Array.isArray(entry.projection.services)
				? entry.projection.services
				: []
			const subscriptions = Array.isArray(entry.projection.subscriptions)
				? entry.projection.subscriptions
				: []
			const retrievers = Array.isArray(entry.projection.retrievers)
				? entry.projection.retrievers
				: []
			return {
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
			}
		})
	},
	async buildCandidates(input) {
		const rows = input.optionalRows.packageRows
		if (rows.length === 0) return []
		// Platform rows rank lexically in every mode: the Vectorize index is
		// per-user (no vectors exist for them in the caller's namespace), and
		// the offline deterministic-embedding fallback is skipped too so
		// online and offline ranking stay consistent with that contract.
		const vectorEligibleRows = rows.filter((row) => !row.platformScope)
		// Fail closed in every mode: no userId, and foreign rows never enter
		// ranking unless the loader explicitly marked them as platform
		// (built-in) scope rows — the one lane that resolves live for every
		// caller (decision record 0014).
		if (!input.userId) return []
		if (
			rows.some(
				(row) => row.record.userId !== input.userId && !row.platformScope,
			)
		) {
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
		if (!input.offline && input.userId && vectorEligibleRows.length > 0) {
			try {
				vectorScoresByRecordId = await queryPackageVectorScores({
					env: input.env,
					query: input.query,
					rows: vectorEligibleRows,
					userId: input.userId,
					limit: input.limit,
					...(input.sharedQueryVector
						? { queryVector: input.sharedQueryVector }
						: {}),
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
		const candidates = rows
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
				const scoreComponents = entry.platformScope
					? buildCandidateBaseScore({ lexical })
					: vectorScoresByRecordId != null
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
						platformScope: entry.platformScope ?? null,
						readmeSnippet: entry.readmeSnippet ?? null,
						actionMatches,
					},
					type: 'package' as const,
					id: entry.record.kodyId,
					title: entry.record.name,
					packageIdentityFields: [
						entry.record.kodyId,
						entry.record.name,
						...entry.record.tags,
						readmeSnippet,
					],
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
							service.timeoutMs != null
								? `timeout-ms:${service.timeoutMs}`
								: '',
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
		const candidateIds = candidates.map(
			(candidate) => candidate.match.packageId,
		)
		const lexicalById = new Map(
			candidates.map(
				(candidate) =>
					[
						candidate.match.packageId,
						candidate.scoreComponents.lexical,
					] as const,
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
	},
	formatSlimMatch({ match, baseUrl, packageAppBaseUrl, username }) {
		const rootImportUsage = buildPackageRootImportUsage(match.name)
		const actionMatches = (match.actionMatches ?? []).map((actionMatch) => {
			const importSpecifier = buildPackageImportSpecifier(
				match.name,
				actionMatch.subpath,
			)
			return {
				subpath: actionMatch.subpath,
				importSpecifier,
				description: actionMatch.description,
				typeDefinition: actionMatch.typeDefinition,
				functions: actionMatch.functions.map((fn) => ({
					name: fn.name,
					description: fn.description,
					typeDefinition: fn.typeDefinition,
					usage: buildPackageActionImportUsage({
						packageName: match.name,
						subpath: actionMatch.subpath,
						functionName: fn.name,
					}),
				})),
				score: actionMatch.score,
				matchedTerms: actionMatch.matchedTerms,
			}
		})
		const [primaryAction] = actionMatches
		const primaryActionFunction = primaryAction
			? getPrimaryPackageActionFunction(primaryAction)
			: null
		const platformSuffix = match.platformScope
			? ` This is a platform (built-in) package: the import resolves live from @${match.platformScope} — no fork needed, and it runs in your runtime against your secrets.`
			: ''
		const nextStep =
			primaryAction && primaryActionFunction
				? `Use ${primaryActionFunction.usage}; inspect search({ entity: "${match.kodyId}:package" }) only if you need more exports.${platformSuffix}`
				: match.hasApp
					? `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, jobs, and the hosted app URL.${platformSuffix}`
					: `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, then import the needed entry from "${buildPackageImportSpecifier(match.name, '.')}".${platformSuffix}`
		return {
			type: 'package',
			id: match.kodyId,
			entityRef: buildEntityRef(match.kodyId, 'package'),
			packageId: match.packageId,
			kodyId: match.kodyId,
			title: match.title,
			description: match.description,
			usage: primaryActionFunction?.usage ?? rootImportUsage,
			rootImportUsage,
			tags: match.tags,
			hasApp: match.hasApp,
			hidden: match.hidden,
			platformScope: match.platformScope ?? null,
			// Platform package apps are hosted under the platform account's
			// username, not the caller's.
			hostedUrl: (() => {
				const hostedUsername = match.platformScope ?? username
				return match.hasApp && hostedUsername
					? buildPackageHostedUrl({
							packageAppBaseUrl: packageAppBaseUrl ?? null,
							appBaseUrl: baseUrl,
							username: hostedUsername,
							kodyId: match.kodyId,
						})
					: null
			})(),
			readmeSnippet: match.readmeSnippet
				? {
						path: match.readmeSnippet.path,
						snippet: match.readmeSnippet.snippet,
						truncated: match.readmeSnippet.truncated,
					}
				: null,
			actionMatches,
			nextStep,
		}
	},
	formatEntityDetail(detail, options) {
		const exportProjection = buildPackageSearchProjection(
			detail.manifest,
			detail.files,
		)
		const exportDetails = exportProjection.exports.map((exportDetail) => ({
			subpath: exportDetail.subpath,
			description:
				exportDetail.description ??
				exportDetail.functions.find((fn) => fn.description)?.description ??
				null,
		}))
		const jobs = Object.keys(detail.manifest.kody.jobs ?? {}).map((name) => ({
			name,
		}))
		const retrievers = Object.entries(
			detail.manifest.kody.retrievers ?? {},
		).map(([key, retriever]) => ({
			key,
			name: retriever.name,
		}))
		const appEntry = detail.manifest.kody.app?.entry ?? null
		const readmeIntent = buildPackageReadmeIntent({
			files: detail.files,
		})
		const maintain = buildPackageMaintainSnippets(detail.record.kodyId)
		const rootImportUsage = buildPackageRootImportUsage(detail.record.name)
		const followUp = `Use package_get({ package_id: ${JSON.stringify(detail.record.id)} }) for the full README and source, or coding_guide_get({ guide: "package_authoring" }) for types, external invocation, and maintenance workflows.`
		const lines = [
			`# Package — \`${detail.record.kodyId}\``,
			'',
			detail.description,
			'',
			'## Index',
			'',
			`- Entity: \`${buildEntityRef(detail.record.kodyId, 'package')}\``,
			`- Package name: \`${detail.record.name}\``,
			`- Tags: ${detail.record.tags.length > 0 ? detail.record.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`- Has app: ${detail.record.hasApp ? 'yes' : 'no'}`,
			`- Hidden: ${detail.record.hidden ? 'yes' : 'no'}`,
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
		]
		if (exportDetails.length > 0) {
			lines.push('', '## Exports', '', '| Subpath | Purpose |', '| --- | --- |')
			for (const exportDetail of exportDetails) {
				lines.push(
					`| ${formatMarkdownInlineCode(exportDetail.subpath)} | ${escapeMarkdownText(exportDetail.description ?? 'Package export.')} |`,
				)
			}
		}
		if (jobs.length > 0) {
			lines.push(
				'',
				'## Jobs',
				'',
				...jobs.map((job) => `- ${formatMarkdownInlineCode(job.name)}`),
			)
		}
		if (retrievers.length > 0) {
			lines.push(
				'',
				'## Retrievers',
				'',
				...retrievers.map(
					(retriever) =>
						`- ${formatMarkdownInlineCode(retriever.name)} (${formatMarkdownInlineCode(retriever.key)})`,
				),
			)
		}
		if (readmeIntent) {
			lines.push(
				'',
				`## README Intent (${formatMarkdownInlineCode(readmeIntent.path)})`,
				'',
				readmeIntent.content,
				...(readmeIntent.truncated
					? ['', '> README Intent was truncated for this index.']
					: []),
			)
		}
		if (options?.includeBoilerplate ?? true) {
			lines.push('', '## Follow up', '', followUp)
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'package',
				id: detail.record.kodyId,
				entityRef: buildEntityRef(detail.record.kodyId, 'package'),
				title: detail.title,
				description: detail.description,
				usage: rootImportUsage,
				packageId: detail.record.id,
				kodyId: detail.record.kodyId,
				name: detail.record.name,
				tags: detail.record.tags,
				hasApp: detail.record.hasApp,
				hidden: detail.record.hidden,
				platformScope: detail.platformScope ?? null,
				hostedUrl: detail.hostedUrl,
				appEntry,
				maintain,
				exports: exportDetails,
				jobs,
				retrievers,
				readmeIntent,
				followUp,
			},
		}
	},
} satisfies SearchEntityPlugin<'package'>

export async function hydrateTopPackageMatches(input: {
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
