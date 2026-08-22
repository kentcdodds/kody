import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	mergeVectorReindexResults,
	reindexVectorCandidates,
	type VectorReindexCandidate,
	type VectorReindexFailure,
	type VectorReindexResult,
} from '#worker/vectorize/reindex-batches.ts'
import {
	hasReachedReindexDeadline,
	toVectorReindexSweepResult,
	type VectorReindexSweepOptions,
	type VectorReindexSweepResult,
} from '#worker/vectorize/reindex-sweep.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { buildSavedPackageEmbedText } from './embed.ts'
import { listSavedPackagesPage, savedPackageVectorId } from './repo.ts'
import {
	clearSavedPackageSearchIndexDebt,
	getSavedPackageSearchIndexDebtGeneration,
} from './search-index-debt.ts'
import { loadPackageManifestBySourceId } from './source.ts'

// Saved packages are reindexed in keyset-paged batches so memory stays
// bounded regardless of table size (each row also loads its manifest).
const reindexPageSize = 200

export async function reindexSavedPackageVectors(
	env: Env,
	input: { baseUrl: string } & VectorReindexSweepOptions,
): Promise<VectorReindexSweepResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0, complete: true, afterId: null }
	}

	const pageResults: Array<VectorReindexResult> = []
	let afterId: string | null = input.afterId ?? null
	while (true) {
		if (hasReachedReindexDeadline(input.deadlineMs) && pageResults.length > 0) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults('saved package', pageResults),
				{ complete: false, afterId },
			)
		}
		const rows = await runD1WithRetry(() =>
			listSavedPackagesPage(env.APP_DB, {
				afterId,
				limit: reindexPageSize,
			}),
		)
		if (rows.length === 0) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults('saved package', pageResults),
				{ complete: true, afterId: null },
			)
		}
		const loadFailures: Array<VectorReindexFailure> = []
		const candidates: Array<VectorReindexCandidate> = []
		const processedRows: typeof rows = []
		let stoppedEarly = false
		for (const row of rows) {
			if (
				hasReachedReindexDeadline(input.deadlineMs) &&
				processedRows.length > 0
			) {
				stoppedEarly = true
				break
			}
			processedRows.push(row)
			try {
				const { manifest } = await loadPackageManifestBySourceId({
					env,
					baseUrl: input.baseUrl,
					userId: row.userId,
					sourceId: row.sourceId,
				})
				candidates.push({
					id: savedPackageVectorId(row.id),
					text: buildSavedPackageEmbedText(manifest),
					namespace: userVectorNamespace(row.userId),
					metadata: {
						kind: 'package',
						userId: row.userId,
					},
				})
			} catch (error) {
				const failure = {
					id: savedPackageVectorId(row.id),
					phase: 'load' as const,
					error: getErrorMessage(error),
				}
				loadFailures.push(failure)
				console.error(
					JSON.stringify({
						message: 'saved package vector reindex skipped package',
						packageId: row.id,
						sourceId: row.sourceId,
						error: failure.error,
					}),
				)
			}
		}
		if (loadFailures.length > 0) {
			pageResults.push({
				upserted: 0,
				failed: loadFailures.length,
				failures: loadFailures,
				failedIds: loadFailures.map((failure) => failure.id),
			})
		}
		if (candidates.length > 0) {
			// Snapshot debt generations before upsert so a concurrent publish
			// that bumps generation is not wiped by post-page cleanup.
			const debtGenerations = new Map<string, number>()
			for (const row of processedRows) {
				const generation = await getSavedPackageSearchIndexDebtGeneration({
					db: env.APP_DB,
					packageId: row.id,
				})
				if (generation !== null) {
					debtGenerations.set(row.id, generation)
				}
			}
			const pageResult = await reindexVectorCandidates({
				env,
				index,
				kind: 'saved package',
				candidates,
			})
			pageResults.push(pageResult)
			// Prefer uncapped failedIds (failures is a capped sample for messages).
			const failedIds = new Set(
				pageResult.failedIds ??
					(pageResult.failures ?? []).map((failure) => failure.id),
			)
			// Self-heal deferred upsert debt observed before this page upsert.
			for (const row of processedRows) {
				const vectorId = savedPackageVectorId(row.id)
				if (failedIds.has(vectorId)) continue
				if (loadFailures.some((failure) => failure.id === vectorId)) continue
				const generation = debtGenerations.get(row.id)
				if (generation === undefined) continue
				await clearSavedPackageSearchIndexDebt({
					db: env.APP_DB,
					packageId: row.id,
					generation,
				})
			}
		}
		afterId = processedRows[processedRows.length - 1]?.id ?? afterId
		if (stoppedEarly) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults('saved package', pageResults),
				{ complete: false, afterId },
			)
		}
		if (rows.length < reindexPageSize) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults('saved package', pageResults),
				{ complete: true, afterId: null },
			)
		}
	}
}
