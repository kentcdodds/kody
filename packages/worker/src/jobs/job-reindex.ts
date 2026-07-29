import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	mergeVectorReindexResults,
	reindexVectorCandidates,
	type VectorReindexResult,
} from '#worker/vectorize/reindex-batches.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { listJobRowsPage } from './repo.ts'
import { toJobView } from './schedule.ts'

// Jobs are reindexed in keyset-paged batches so memory stays bounded
// regardless of table size.
const reindexPageSize = 200

export async function reindexJobVectors(
	env: Env,
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
			listJobRowsPage(env.APP_DB, {
				afterId,
				limit: reindexPageSize,
			}),
		)
		if (rows.length === 0) break
		const candidates = rows
			.filter((row) => row.user_id)
			.map((row) => {
				const view = toJobView(row.record)
				return {
					id: jobVectorId(row.id),
					text: buildJobEmbedText({
						name: view.name,
						scheduleSummary: view.scheduleSummary,
						sourceId: view.sourceId,
						publishedCommit: view.publishedCommit,
					}),
					metadata: { kind: 'job', userId: row.user_id },
				}
			})
		if (candidates.length > 0) {
			pageResults.push(
				await reindexVectorCandidates({
					env,
					index,
					kind: 'job',
					candidates,
				}),
			)
		}
		if (rows.length < reindexPageSize) break
		afterId = rows[rows.length - 1]!.id
	}
	return mergeVectorReindexResults('job', pageResults)
}
