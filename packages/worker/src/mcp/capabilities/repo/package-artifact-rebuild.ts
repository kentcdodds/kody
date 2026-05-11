import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

export async function rebuildPublishedPackageArtifactsViaRepoSession(input: {
	env: Env
	rpcSessionId: string
	sessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
	baseUrl: string
}) {
	const session = repoSessionRpc(input.env, input.rpcSessionId)
	const targets = await session.listPublishedPackageArtifactTargets({
		sessionId: input.sessionId,
		sourceId: input.sourceId,
		userId: input.userId,
	})
	for (const target of targets) {
		await repoSessionRpc(
			input.env,
			input.rpcSessionId,
		).rebuildPublishedPackageArtifact({
			sessionId: input.sessionId,
			sourceId: input.sourceId,
			userId: input.userId,
			publishedCommit: input.publishedCommit,
			target,
			baseUrl: input.baseUrl,
		})
	}
}
