import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	reindexPagedVectorRows,
	type VectorReindexSweepOptions,
	type VectorReindexSweepResult,
} from '#worker/vectorize/reindex-sweep.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { jobsData } from './jobs-data.ts'
import { toJobView } from './schedule.ts'

// Jobs are reindexed in keyset-paged batches so memory stays bounded
// regardless of table size.
const reindexPageSize = 200

export async function reindexJobVectors(
	env: Env,
	options?: VectorReindexSweepOptions,
): Promise<VectorReindexSweepResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0, complete: true, afterId: null }
	}

	return reindexPagedVectorRows({
		env,
		index,
		kind: 'job',
		pageSize: reindexPageSize,
		afterId: options?.afterId,
		deadlineMs: options?.deadlineMs,
		listPage: ({ afterId, limit }) =>
			runD1WithRetry(() =>
				jobsData(env).listJobsPage({
					afterId,
					limit,
				}),
			),
		rowId: (row) => row.id,
		toCandidate: (row) => {
			if (!row.user_id) return null
			const view = toJobView(row.record)
			return {
				id: jobVectorId(row.id),
				text: buildJobEmbedText({
					name: view.name,
					scheduleSummary: view.scheduleSummary,
					sourceId: view.sourceId,
					publishedCommit: view.publishedCommit,
				}),
				namespace: userVectorNamespace(row.user_id),
				metadata: { kind: 'job', userId: row.user_id },
			}
		},
	})
}
