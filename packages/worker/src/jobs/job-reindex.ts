import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { listJobs } from './service.ts'

const upsertBatchSize = 16

type JobEmbeddingBatchResult = { data?: Array<Array<number>> }

export async function reindexJobVectors(
	env: Env,
): Promise<{ upserted: number }> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const rows = await env.APP_DB.prepare(
		`SELECT DISTINCT user_id FROM jobs WHERE source_id IS NOT NULL OR code IS NOT NULL`,
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

	let upserted = 0
	for (let offset = 0; offset < jobs.length; offset += upsertBatchSize) {
		const batch = jobs.slice(offset, offset + upsertBatchSize)
		const texts = batch.map(({ job }) =>
			buildJobEmbedText({
				name: job.name,
				description: job.name,
				scheduleSummary: job.scheduleSummary,
				sourceId: job.sourceId,
				publishedCommit: job.publishedCommit,
			}),
		)
		const result = (await env.AI.run('@cf/baai/bge-small-en-v1.5', {
			text: texts,
			pooling: 'mean',
		})) as JobEmbeddingBatchResult
		const vectors = result.data
		if (!vectors || vectors.length !== batch.length) {
			throw new Error('Workers AI embedding batch size mismatch for jobs')
		}
		await index.upsert(
			batch.map(({ userId, job }, index_) => ({
				id: jobVectorId(job.id),
				values: vectors[index_]!,
				metadata: { kind: 'job', userId },
			})),
		)
		upserted += batch.length
	}

	return { upserted }
}
