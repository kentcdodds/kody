import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

export async function rebuildPublishedPackageArtifactsViaRepoSession(input: {
	env: Env
	rpcSessionId: string
	repoSessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
	baseUrl: string
}) {
	try {
		const session = repoSessionRpc(input.env, input.rpcSessionId)
		const targets = await session.listPublishedPackageArtifactTargets({
			sessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
		})
		for (const target of targets) {
			await session.rebuildPublishedPackageArtifact({
				sessionId: input.repoSessionId,
				sourceId: input.sourceId,
				userId: input.userId,
				publishedCommit: input.publishedCommit,
				target,
				baseUrl: input.baseUrl,
			})
		}
	} catch (error) {
		throw new Error(
			`Package source publish succeeded, but bundle artifact rebuild failed for source "${input.sourceId}" at commit "${input.publishedCommit}". Re-run the publish capability to repair artifacts.`,
			{ cause: error },
		)
	}
}
