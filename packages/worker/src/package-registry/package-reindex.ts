import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	mergeVectorReindexResults,
	reindexVectorCandidates,
	vectorReindexUpsertBatchSize,
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

type SavedPackageRow = Awaited<ReturnType<typeof listSavedPackagesPage>>[number]

export async function reindexSavedPackageVectors(
	env: Env,
	input: { baseUrl: string } & VectorReindexSweepOptions,
): Promise<VectorReindexSweepResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	const vectorIndex = index
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0, complete: true, afterId: null }
	}

	const pageResults: Array<VectorReindexResult> = []
	let afterId: string | null = input.afterId ?? null

	async function flushChunk(chunk: {
		rows: Array<SavedPackageRow>
		candidates: Array<VectorReindexCandidate>
		loadFailures: Array<VectorReindexFailure>
	}) {
		if (chunk.loadFailures.length > 0) {
			pageResults.push({
				upserted: 0,
				failed: chunk.loadFailures.length,
				failures: chunk.loadFailures,
				failedIds: chunk.loadFailures.map((failure) => failure.id),
			})
		}
		if (chunk.candidates.length === 0) return
		// Snapshot debt generations before upsert so a concurrent publish
		// that bumps generation is not wiped by post-page cleanup.
		const debtGenerations = new Map<string, number>()
		for (const row of chunk.rows) {
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
			index: vectorIndex,
			kind: 'saved package',
			candidates: chunk.candidates,
			force: input.force,
		})
		pageResults.push(pageResult)
		// Prefer uncapped failedIds (failures is a capped sample for messages).
		const failedIds = new Set(
			pageResult.failedIds ??
				(pageResult.failures ?? []).map((failure) => failure.id),
		)
		// Self-heal deferred upsert debt observed before this chunk upsert.
		for (const row of chunk.rows) {
			const vectorId = savedPackageVectorId(row.id)
			if (failedIds.has(vectorId)) continue
			if (chunk.loadFailures.some((failure) => failure.id === vectorId)) {
				continue
			}
			const generation = debtGenerations.get(row.id)
			if (generation === undefined) continue
			await clearSavedPackageSearchIndexDebt({
				db: env.APP_DB,
				packageId: row.id,
				generation,
			})
		}
	}

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
		const processedRows: Array<SavedPackageRow> = []
		let stoppedEarly = false
		for (const row of rows) {
			if (
				hasReachedReindexDeadline(input.deadlineMs) &&
				(processedRows.length > 0 || pageResults.length > 0)
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
			if (processedRows.length >= vectorReindexUpsertBatchSize) {
				await flushChunk({
					rows: processedRows.splice(0),
					candidates: candidates.splice(0),
					loadFailures: loadFailures.splice(0),
				})
				afterId = row.id
				if (hasReachedReindexDeadline(input.deadlineMs)) {
					stoppedEarly = true
					break
				}
			}
		}
		if (processedRows.length > 0 || loadFailures.length > 0) {
			const lastProcessed = processedRows[processedRows.length - 1]
			await flushChunk({
				rows: processedRows,
				candidates,
				loadFailures,
			})
			if (lastProcessed) afterId = lastProcessed.id
		}
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
