import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import {
	reindexVectorCandidates,
	type VectorReindexResult,
} from '#mcp/capabilities/reindex-batches.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { listJobs } from './service.ts'

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

	const rows = await env.APP_DB.prepare(
		`SELECT DISTINCT user_id FROM jobs`,
	).all<{ user_id: string }>()
	const userIds = (rows.results ?? []).map((row) => row.user_id).filter(Boolean)
	if (userIds.length === 0) return { upserted: 0 }

	const jobs = (
		await Promise.all(
			userIds.map((userId) =>
				listJobs({
					env,
					userId,
				}).then((userJobs) => userJobs.map((job) => ({ userId, job }))),
			),
		)
	).flat()
	if (jobs.length === 0) return { upserted: 0 }

	return reindexVectorCandidates({
		env,
		index,
		kind: 'job',
		candidates: jobs.map(({ userId, job }) => ({
			id: jobVectorId(job.id),
			text: buildJobEmbedText({
				name: job.name,
				scheduleSummary: job.scheduleSummary,
				sourceId: job.sourceId,
				publishedCommit: job.publishedCommit,
			}),
			metadata: { kind: 'job', userId },
		})),
	})
}
