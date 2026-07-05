import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import {
	reindexVectorCandidates,
	type VectorReindexCandidate,
	type VectorReindexFailure,
} from '#mcp/capabilities/reindex-batches.ts'
import { getErrorMessage } from '#mcp/capabilities/error-message.ts'
import { buildSavedPackageEmbedText } from './embed.ts'
import { listAllSavedPackages, savedPackageVectorId } from './repo.ts'
import { loadPackageManifestBySourceId } from './source.ts'

export async function reindexSavedPackageVectors(
	env: Env,
	input: { baseUrl: string },
): Promise<{
	upserted: number
	failed?: number
	warning?: string
	error?: string
	failures?: Array<VectorReindexFailure>
}> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const rows = await listAllSavedPackages(env.APP_DB)
	if (rows.length === 0) {
		return { upserted: 0 }
	}

	let failed = 0
	const failures: Array<VectorReindexFailure> = []
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
				metadata: {
					kind: 'package',
					userId: row.userId,
				},
			})
		} catch (error) {
			failed += 1
			const failure = {
				id: savedPackageVectorId(row.id),
				phase: 'load' as const,
				error: getErrorMessage(error),
			}
			failures.push(failure)
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

	const result = await reindexVectorCandidates({
		env,
		index,
		kind: 'saved package',
		candidates,
	})
	const totalFailed = failed + (result.failed ?? 0)
	const allFailures = [...failures, ...(result.failures ?? [])]
	if (totalFailed === 0) return { upserted: result.upserted }

	const summary = `${totalFailed} saved package vector(s) failed to reindex`
	return {
		upserted: result.upserted,
		failed: totalFailed,
		failures: allFailures,
		...(result.upserted === 0 ? { error: summary } : { warning: summary }),
	}
}
