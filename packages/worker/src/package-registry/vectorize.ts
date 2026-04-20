import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { savedPackageVectorId } from './repo.ts'

export async function upsertSavedPackageVector(
	env: Env,
	input: {
		packageId: string
		userId: string
		embedText: string
	},
) {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: savedPackageVectorId(input.packageId),
			values,
			metadata: {
				kind: 'package',
				userId: input.userId,
			},
		},
	])
}

export async function deleteSavedPackageVector(env: Env, packageId: string) {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	await index.deleteByIds([savedPackageVectorId(packageId)])
}
