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
import { buildExternalPackageInvocationDescriptor } from '#worker/package-invocations/public-url.ts'
import {
	buildPackageSearchDocument,
	buildPackageSearchProjection,
	type PackageSearchProjection,
} from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { buildPackageReadmeDetail } from '#worker/package-registry/package-readme.ts'
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
	formatInlineTypeDefinition,
	formatPackageSchedule,
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
		// Fail closed in every mode: no userId or foreign rows never enter ranking.
		if (!input.userId) return []
		if (rows.some((row) => row.record.userId !== input.userId)) {
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
					rows,
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
		const hostedAppOrigin = packageAppBaseUrl ?? baseUrl
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
		const nextStep =
			primaryAction && primaryActionFunction
				? `Use ${primaryActionFunction.usage}; inspect search({ entity: "${match.kodyId}:package" }) only if you need more exports.`
				: match.hasApp
					? `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, jobs, and the hosted app URL.`
					: `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, then import the needed entry from "${buildPackageImportSpecifier(match.name, '.')}".`
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
			hostedUrl:
				match.hasApp && username
					? buildPackageHostedUrl(hostedAppOrigin, username, match.kodyId)
					: null,
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
	formatEntityDetail(detail) {
		const exportProjection = buildPackageSearchProjection(
			detail.manifest,
			detail.files,
		)
		const exportDetails = exportProjection.exports.map((exportDetail) => ({
			...exportDetail,
			importSpecifier: buildPackageImportSpecifier(
				detail.record.name,
				exportDetail.subpath,
			),
			externalInvocation: detail.ownerUsername
				? buildExternalPackageInvocationDescriptor({
						baseUrl: detail.baseUrl,
						ownerUsername: detail.ownerUsername,
						kodyId: detail.record.kodyId,
						exportName: exportDetail.subpath,
					})
				: null,
		}))
		const jobs = Object.entries(detail.manifest.kody.jobs ?? {}).map(
			([jobName, job]) => ({
				name: jobName,
				entry: job.entry,
				scheduleSummary: formatPackageSchedule(job.schedule, job.timezone),
				enabled: job.enabled ?? true,
			}),
		)
		const retrievers = Object.entries(
			detail.manifest.kody.retrievers ?? {},
		).map(([key, retriever]) => ({
			key,
			exportName: retriever.export,
			name: retriever.name,
			description: retriever.description,
			scopes: retriever.scopes,
			timeoutMs: retriever.timeoutMs ?? null,
			maxResults: retriever.maxResults ?? null,
		}))
		const appEntry = detail.manifest.kody.app?.entry ?? null
		const readme = buildPackageReadmeDetail({
			files: detail.files,
		})
		const maintain = buildPackageMaintainSnippets(detail.record.kodyId)
		const invokeUsage = `packages.invoke({ kodyId: ${JSON.stringify(detail.record.kodyId)}, exportName, params })`
		const rootImportUsage = buildPackageRootImportUsage(detail.record.name)
		const lines = [
			`# Package — \`${detail.record.kodyId}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.record.kodyId, 'package')}\``,
			`- Package id: \`${detail.record.id}\``,
			`- Package name: \`${detail.record.name}\``,
			`- Kody id: \`${detail.record.kodyId}\``,
			`- Tags: ${detail.record.tags.length > 0 ? detail.record.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`- Has app: ${detail.record.hasApp ? 'yes' : 'no'}`,
			`- Hidden: ${detail.record.hidden ? 'yes' : 'no'}`,
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
			'',
			'## Maintain',
			'',
			`- Git lane: \`${maintain.gitLane}\` → clone → edit → push → \`${maintain.publish}\``,
			'- Tool-only: `package_save` / repo sessions; full guide: `coding_guide_get({ guide: "package_authoring" })`',
			'',
			'## Import vs invoke',
			'',
			`- Default — package name known when the code is written: ${formatMarkdownInlineCode(rootImportUsage)}. Static \`kody:\` imports use the npm-scoped package name (${formatMarkdownInlineCode(detail.record.name)}); typed, publish-verified, zero per-call platform cost.`,
			`- Dynamic — name is data, the call needs this package's own runtime (secret mounts, \`packageStorage()\`), or exactly-once: ${formatMarkdownInlineCode(invokeUsage)}. Always contract-checked; keyless is lean/ephemeral, pass \`idempotencyKey\` only for exactly-once. The \`kodyId\` is the bare Kody id (${formatMarkdownInlineCode(detail.record.kodyId)}), not the npm-scoped package name.`,
		]
		if (appEntry) {
			lines.push(
				'',
				'## App',
				'',
				`- Entry: \`${appEntry}\``,
				...(detail.hostedUrl ? [`- Open: \`${detail.hostedUrl}\``] : []),
			)
		}
		if (exportDetails.length > 0) {
			lines.push('', '## Exports', '')
			for (const exportDetail of exportDetails) {
				lines.push(
					`- \`${exportDetail.subpath}\` -> \`${exportDetail.importSpecifier}\`${exportDetail.runtimeTarget ? ` (runtime target: \`${exportDetail.runtimeTarget}\`)` : ''}${exportDetail.typesPath ? ` (types: \`${exportDetail.typesPath}\`)` : ''}`,
				)
				if (exportDetail.externalInvocation) {
					lines.push(
						`  - External invocation: \`${exportDetail.externalInvocation.method} ${exportDetail.externalInvocation.url}\``,
						`  - Route export name: \`${exportDetail.externalInvocation.routeExportName}\`; normalized export name for token scope checks: \`${exportDetail.externalInvocation.normalizedExportName}\``,
						`  - Token setup URL: \`${exportDetail.externalInvocation.tokenSetupUrl}\` (setup only; not an invocation URL)`,
						`  - Source: ${escapeMarkdownText(exportDetail.externalInvocation.sourceGuidance)}`,
					)
				}
				for (const exportedFunction of exportDetail.functions) {
					if (exportedFunction.description) {
						lines.push(
							`  - ${escapeMarkdownText(exportedFunction.description)}`,
						)
					}
					if (exportedFunction.typeDefinition) {
						lines.push(
							`  - \`${formatInlineTypeDefinition(exportedFunction.typeDefinition)}\``,
						)
					}
				}
				if (exportDetail.referencedTypes.length > 0) {
					lines.push('  - Referenced types:', '    ```ts')
					exportDetail.referencedTypes.forEach((referencedType, index) => {
						if (index > 0) lines.push('    ')
						lines.push(
							...referencedType.definition
								.split('\n')
								.map((line) => `    ${line}`),
						)
					})
					lines.push('    ```')
				}
			}
		}
		if (jobs.length > 0) {
			lines.push('', '## Jobs', '')
			for (const job of jobs) {
				lines.push(
					`- \`${job.name}\` -> \`${job.entry}\` — ${job.scheduleSummary}${job.enabled ? '' : ' (disabled)'}`,
				)
			}
		}
		if (retrievers.length > 0) {
			lines.push('', '## Retrievers', '')
			for (const retriever of retrievers) {
				lines.push(
					`- ${formatMarkdownInlineCode(retriever.key)} -> ${formatMarkdownInlineCode(retriever.exportName)} — ${escapeMarkdownText(retriever.description)} (scopes: ${retriever.scopes.map((scope) => formatMarkdownInlineCode(scope)).join(', ')})`,
				)
			}
		}
		if (readme) {
			lines.push(
				'',
				`## README (\`${readme.path}\`)`,
				'',
				readme.content,
				...(readme.truncated
					? ['', '> README content was truncated for this detail response.']
					: []),
			)
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
				hostedUrl: detail.hostedUrl,
				appEntry,
				maintain,
				exports: exportDetails,
				jobs,
				retrievers,
				readme,
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
