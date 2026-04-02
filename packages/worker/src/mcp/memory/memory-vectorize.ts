import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { type MemoryStatus } from './types.ts'

export function memoryVectorId(memoryId: string): string {
	return `memory_${memoryId}`
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
