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
	succeeded: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	failed: ReadonlyArray<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}>
	error?: unknown
}) {
	const succeededSummary =
		input.succeeded.length === 0
			? 'none'
			: input.succeeded
					.map((target) => `{ ${describePackageArtifactTarget(target)} }`)
					.join(', ')
	const failedSummary =
		input.failed.length === 0
			? input.error
				? formatErrorCauseChain(input.error)
				: 'unknown'
			: input.failed
					.map(
						({ target, error }) =>
							`{ ${describePackageArtifactTarget(target)} }: ${formatErrorCauseChain(error)}`,
					)
					.join('; ')
	// Partial artifact writes were already possible with sequential rebuilds
	// (earlier targets stay written when a later one fails). Bounded concurrency
	// only widens that to the in-flight peer in the current chunk; later chunks
	// are not scheduled after a failure.
	return `Package source publish succeeded, but bundle artifact rebuild failed for source "${input.sourceId}" at commit "${input.publishedCommit}". Succeeded: ${succeededSummary}. Failed: ${failedSummary}. Re-run the publish capability to repair artifacts.`
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
				succeeded: [],
				failed: [],
				error,
			}),
			{ cause: error },
		)
	}

	const succeeded: Array<PublishedPackageArtifactBuildTarget> = []
	const failed: Array<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}> = []

	for (const targetChunk of chunkArray(
		targets,
		publishedPackageArtifactRebuildConcurrency,
	)) {
		if (failed.length > 0) break

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
				return target
			}),
		)

		for (const [index, result] of settled.entries()) {
			const target = targetChunk[index]
			if (!target) continue
			if (result.status === 'fulfilled') {
				succeeded.push(target)
				continue
			}
			failed.push({ target, error: result.reason })
		}
	}

	if (failed.length === 0) return

	throw new Error(
		buildRebuildFailureMessage({
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			succeeded,
			failed,
		}),
		{ cause: failed[0]?.error },
	)
}
