import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	recordVectorEmbedFingerprint,
	shouldSkipVectorEmbed,
	tryDeleteVectorEmbedFingerprint,
} from '#worker/vectorize/embed-fingerprints.ts'
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
	const vectorId = savedPackageVectorId(input.packageId)
	const namespace = userVectorNamespace(input.userId)
	if (
		await shouldSkipVectorEmbed({
			env,
			userId: namespace,
			vectorId,
			text: input.embedText,
		})
	) {
		return
	}
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: vectorId,
			values,
			namespace,
			metadata: {
				kind: 'package',
				userId: input.userId,
			},
		},
	])
	await recordVectorEmbedFingerprint({
		env,
		userId: namespace,
		vectorId,
		text: input.embedText,
	})
}

export async function deleteSavedPackageVector(env: Env, packageId: string) {
	const vectorId = savedPackageVectorId(packageId)
	await tryDeleteVectorEmbedFingerprint({ env, vectorId })
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	await index.deleteByIds([vectorId])
}
