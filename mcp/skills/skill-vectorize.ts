import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { skillVectorId } from './mcp-skills-repo.ts'

export async function upsertSkillVector(
	env: Env,
	input: { skillId: string; userId: string; embedText: string },
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: skillVectorId(input.skillId),
			values,
			metadata: { kind: 'skill', userId: input.userId },
		},
	])
}

export async function deleteSkillVector(env: Env, skillId: string): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index) return
	await index.deleteByIds([skillVectorId(skillId)])
}
