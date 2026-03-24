import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { uiArtifactVectorId } from '#mcp/ui-artifacts-repo.ts'

export async function upsertUiArtifactVector(
	env: Env,
	input: { appId: string; userId: string; embedText: string },
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: uiArtifactVectorId(input.appId),
			values,
			metadata: { kind: 'ui_artifact', userId: input.userId },
		},
	])
}

async function deleteUiArtifactVector(
	env: Env,
	appId: string,
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index) return
	await index.deleteByIds([uiArtifactVectorId(appId)])
}
