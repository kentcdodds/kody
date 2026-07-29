import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { formatErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { isPublishedPackageArtifactBuiltForCommit } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { type PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import { createIsolatedArtifactRebuildRunner } from '#worker/repo/isolated-artifact-rebuild.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

/**
 * Same-session rebuild RPCs hit one Durable Object, which serializes
 * execution. Depth 2 pipelines the next RPC while the DO finishes the current
 * one (cuts inter-call worker round-trip idle time) without flooding the DO
 * input gate the way unbounded Promise.all would. The isolated throwaway-DO
 * path uses the same bound so fan-out stays modest.
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

async function filterTargetsNeedingRebuild(input: {
	env: Env
	userId: string
	sourceId: string
	publishedCommit: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
}) {
	const remaining: Array<PublishedPackageArtifactBuildTarget> = []
	const alreadyBuilt: Array<PublishedPackageArtifactBuildTarget> = []
	for (const target of input.targets) {
		const built = await isPublishedPackageArtifactBuiltForCommit({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
		})
		if (built) {
			alreadyBuilt.push(target)
			continue
		}
		remaining.push(target)
	}
	return { remaining, alreadyBuilt }
}

async function listTargetsOrThrow(input: {
	session: ReturnType<typeof repoSessionRpc>
	repoSessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
}) {
	try {
		return await input.session.listPublishedPackageArtifactTargets({
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
}

async function rebuildPublishedPackageArtifactsOnSession(input: {
	env: Env
	rpcSessionId: string
	repoSessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
	baseUrl: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
}) {
	const session = repoSessionRpc(input.env, input.rpcSessionId)
	const succeeded: Array<PublishedPackageArtifactBuildTarget> = []
	const { remaining, alreadyBuilt } = await filterTargetsNeedingRebuild({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		targets: input.targets,
	})
	succeeded.push(...alreadyBuilt)

	const failed: Array<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}> = []

	for (const targetChunk of chunkArray(
		remaining,
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
	const isolatedRunner = createIsolatedArtifactRebuildRunner(input.env)

	if (!isolatedRunner) {
		const targets = await listTargetsOrThrow({
			session,
			repoSessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
			publishedCommit: input.publishedCommit,
		})
		await rebuildPublishedPackageArtifactsOnSession({
			...input,
			targets,
		})
		return
	}

	// List + skip before staging so already_published / repair resumes do not
	// pay collectWorkspaceFiles + KV stage when nothing remains to rebuild.
	const targets = await listTargetsOrThrow({
		session,
		repoSessionId: input.repoSessionId,
		sourceId: input.sourceId,
		userId: input.userId,
		publishedCommit: input.publishedCommit,
	})

	const { remaining, alreadyBuilt } = await filterTargetsNeedingRebuild({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		targets,
	})
	const succeeded: Array<PublishedPackageArtifactBuildTarget> = [
		...alreadyBuilt,
	]
	if (remaining.length === 0) return

	let stagingKey: string
	try {
		;({ stagingKey } = await session.stagePublishedPackageArtifactRebuild({
			sessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
		}))
	} catch (error) {
		throw new Error(
			buildRebuildFailureMessage({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
				succeeded,
				failed: [],
				error,
			}),
			{ cause: error },
		)
	}

	const failed: Array<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}> = []

	try {
		const targetChunks = chunkArray(
			remaining,
			publishedPackageArtifactRebuildConcurrency,
		)
		for (const [chunkIndex, targetChunk] of targetChunks.entries()) {
			if (failed.length > 0) break
			if (chunkIndex > 0) {
				await isolatedRunner.touch(stagingKey)
			}

			const settled = await Promise.allSettled(
				targetChunk.map(async (target) => {
					const outcome = await isolatedRunner.run({
						stagingKey,
						sourceId: input.sourceId,
						userId: input.userId,
						publishedCommit: input.publishedCommit,
						target,
						baseUrl: input.baseUrl,
					})
					if (!outcome.ok) {
						throw new Error(outcome.message)
					}
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
	} finally {
		await isolatedRunner.discard(stagingKey)
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
