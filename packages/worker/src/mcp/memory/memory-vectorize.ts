import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import { buildLengthSafeVectorId } from '#worker/vectorize/vector-ids.ts'
import { type MemoryStatus } from './types.ts'

export function memoryVectorId(memoryId: string): string {
	return buildLengthSafeVectorId({ prefix: 'memory', rawId: memoryId })
}

export async function upsertMemoryVector(
	env: Env,
	input: {
		memoryId: string
		userId: string
		category: string | null
		status: MemoryStatus
		embedText: string
	},
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: memoryVectorId(input.memoryId),
			values,
			metadata: {
				kind: 'memory',
				userId: input.userId,
				status: input.status,
				...(input.category ? { category: input.category } : {}),
			},
		},
	])
}

export async function deleteMemoryVector(
	env: Env,
	memoryId: string,
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	await index.deleteByIds([memoryVectorId(memoryId)])
}
