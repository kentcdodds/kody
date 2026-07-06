import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'

const vectorizeMaxIdBytes = 64
const textEncoder = new TextEncoder()

function getUtf8ByteLength(value: string) {
	return textEncoder.encode(value).byteLength
}

function hashVectorIdSource(value: string) {
	let hash = 0xcbf29ce484222325n
	for (const byte of textEncoder.encode(value)) {
		hash ^= BigInt(byte)
		hash = BigInt.asUintN(64, hash * 0x100000001b3n)
	}
	return hash.toString(36)
}

export function jobVectorId(jobId: string): string {
	const id = `job_${jobId}`
	if (getUtf8ByteLength(id) <= vectorizeMaxIdBytes) return id
	return `job_${hashVectorIdSource(jobId)}`
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
