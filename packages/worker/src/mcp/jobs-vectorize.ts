import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'

export function jobVectorId(jobId: string): string {
	return `job_${jobId}`
}

export async function upsertJobVector(
	env: Env,
	input: {
		jobId: string
		userId: string
		embedText: string
	},
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: jobVectorId(input.jobId),
			values,
			metadata: { kind: 'job', userId: input.userId },
		},
	])
}

export async function deleteJobVector(env: Env, jobId: string): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	await index.deleteByIds([jobVectorId(jobId)])
}
