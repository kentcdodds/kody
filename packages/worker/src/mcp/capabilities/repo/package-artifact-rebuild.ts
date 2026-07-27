import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { formatErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { type PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

/**
 * Same-session rebuild RPCs hit one Durable Object, which serializes
 * execution. Depth 2 pipelines the next RPC while the DO finishes the current
 * one (cuts inter-call worker round-trip idle time) without flooding the DO
 * input gate the way unbounded Promise.all would.
 */
export const publishedPackageArtifactRebuildConcurrency = 2

function describePackageArtifactTarget(
	target: PublishedPackageArtifactBuildTarget,
) {
	return [
		`kind "${target.kind}"`,
		`artifact "${target.artifactName ?? '<default>'}"`,
		`entry "${target.entryPoint}"`,
		`bundle "${target.bundleKind}"`,
	].join(', ')
}

function buildRebuildFailureMessage(input: {
	sourceId: string
	publishedCommit: string
	target?: PublishedPackageArtifactBuildTarget
	error: unknown
}) {
	const target = input.target
		? ` target { ${describePackageArtifactTarget(input.target)} }`
		: ''
	return `Package source publish succeeded, but bundle artifact rebuild failed for source "${input.sourceId}" at commit "${input.publishedCommit}"${target}. Cause: ${formatErrorCauseChain(input.error)}. Re-run the publish capability to repair artifacts.`
}

export async function rebuildPublishedPackageArtifactsViaRepoSession(input: {
	env: Env
	rpcSessionId: string
	repoSessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
	baseUrl: string
}) {
	const session = repoSessionRpc(input.env, input.rpcSessionId)
	let targets: Array<PublishedPackageArtifactBuildTarget>
	try {
		targets = await session.listPublishedPackageArtifactTargets({
			sessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
		})
	} catch (error) {
		throw new Error(
			buildRebuildFailureMessage({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
				error,
			}),
			{ cause: error },
		)
	}
	for (const targetChunk of chunkArray(
		targets,
		publishedPackageArtifactRebuildConcurrency,
	)) {
		const settled = await Promise.allSettled(
			targetChunk.map(async (target) => {
				await session.rebuildPublishedPackageArtifact({
					sessionId: input.repoSessionId,
					sourceId: input.sourceId,
					userId: input.userId,
					publishedCommit: input.publishedCommit,
					target,
					baseUrl: input.baseUrl,
				})
			}),
		)
		for (const [index, result] of settled.entries()) {
			if (result.status === 'fulfilled') continue
			const target = targetChunk[index]
			throw new Error(
				buildRebuildFailureMessage({
					sourceId: input.sourceId,
					publishedCommit: input.publishedCommit,
					target,
					error: result.reason,
				}),
				{ cause: result.reason },
			)
		}
	}
}
