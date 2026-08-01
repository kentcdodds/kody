import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
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
			namespace: userVectorNamespace(input.userId),
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
