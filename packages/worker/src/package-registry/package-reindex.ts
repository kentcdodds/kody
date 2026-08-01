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
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { buildSavedPackageEmbedText } from './embed.ts'
import { listSavedPackagesPage, savedPackageVectorId } from './repo.ts'
import { loadPackageManifestBySourceId } from './source.ts'

// Saved packages are reindexed in keyset-paged batches so memory stays
// bounded regardless of table size (each row also loads its manifest).
const reindexPageSize = 200

export async function reindexSavedPackageVectors(
	env: Env,
	input: { baseUrl: string },
): Promise<VectorReindexResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const pageResults: Array<VectorReindexResult> = []
	let afterId: string | null = null
	while (true) {
		const rows = await runD1WithRetry(() =>
			listSavedPackagesPage(env.APP_DB, {
				afterId,
				limit: reindexPageSize,
			}),
		)
		if (rows.length === 0) break
		const loadFailures: Array<VectorReindexFailure> = []
		const candidates: Array<VectorReindexCandidate> = []
		for (const row of rows) {
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
			})
		}
		if (candidates.length > 0) {
			pageResults.push(
				await reindexVectorCandidates({
					env,
					index,
					kind: 'saved package',
					candidates,
				}),
			)
		}
		if (rows.length < reindexPageSize) break
		afterId = rows[rows.length - 1]!.id
	}
	return mergeVectorReindexResults('saved package', pageResults)
}
