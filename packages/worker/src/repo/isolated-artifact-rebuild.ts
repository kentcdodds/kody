import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { type PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'

/**
 * Heavy published-package artifact rebuilds run in fresh, throwaway
 * `REPO_SESSION` isolates instead of the long-lived publish session Durable
 * Object. One large package (for example morning-briefing) could otherwise
 * push the session isolate (workspace + git state + esbuild-wasm) over the
 * Durable Object memory limit and kill the publish (same class of failure as
 * kentcdodds/kody#987 for check phases). Each target rebuild gets a brand-new
 * DO id, so:
 *
 * - rebuilds never stack their peak memory on top of the session isolate or
 *   each other (esbuild-wasm memory in particular never shrinks once grown),
 * - a package too large for even a single target surfaces as a failed rebuild
 *   with an actionable message instead of an opaque isolate reset, and
 * - the throwaway instances never touch their own Durable Object storage, so
 *   nothing persists for their random ids.
 *
 * Workspace source files are staged once in KV with a short TTL (collected by
 * the session DO) and fetched by each rebuild isolate; the RPC payloads stay
 * small. The orchestrator refreshes that TTL between target chunks so large
 * packages cannot outlive the initial lease mid-fan-out.
 */

export const isolatedArtifactRebuildStagingKeyPrefix =
	'repo-artifact-rebuild-staging:v1:'
const stagingTtlSeconds = 15 * 60

export type IsolatedArtifactRebuildRequest = {
	stagingKey: string
	sourceId: string
	userId: string
	publishedCommit: string
	target: PublishedPackageArtifactBuildTarget
	baseUrl?: string
}

/**
 * Staged snapshots are user-owned content, so the staging key is namespaced
 * by `userId` and the consuming Durable Object verifies the key belongs to
 * the requesting user before reading it.
 */
export function isolatedArtifactRebuildStagingKeyForUser(userId: string) {
	return `${isolatedArtifactRebuildStagingKeyPrefix}${userId}:${crypto.randomUUID()}`
}

export function isolatedArtifactRebuildStagingKeyBelongsToUser(input: {
	stagingKey: string
	userId: string
}) {
	return input.stagingKey.startsWith(
		`${isolatedArtifactRebuildStagingKeyPrefix}${input.userId}:`,
	)
}

export type IsolatedArtifactRebuildOutcome = {
	ok: boolean
	message: string
	skipped?: boolean
	kvKey?: string | null
	target?: PublishedPackageArtifactBuildTarget
}

type IsolatedArtifactRebuildStub = {
	runIsolatedArtifactRebuild(
		input: IsolatedArtifactRebuildRequest,
	): Promise<IsolatedArtifactRebuildOutcome>
}

export type IsolatedArtifactRebuildRunner = {
	/**
	 * Re-put the existing staging payload so its TTL resets. Call between
	 * rebuild chunks so multi-target publishes do not expire mid-fan-out.
	 */
	touch(stagingKey: string): Promise<void>
	run(
		request: IsolatedArtifactRebuildRequest,
	): Promise<IsolatedArtifactRebuildOutcome>
	discard(stagingKey: string): Promise<void>
}

function isDurableObjectResourceLimitResetError(error: unknown) {
	// Remap only memory/CPU limits to the "package too large" outcome.
	// Deploy resets ("code was updated") must propagate so publish can retry.
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

function describeTarget(target: PublishedPackageArtifactBuildTarget) {
	return [
		`kind "${target.kind}"`,
		`artifact "${target.artifactName ?? '<default>'}"`,
		`entry "${target.entryPoint}"`,
		`bundle "${target.bundleKind}"`,
	].join(', ')
}

/**
 * Returns a runner when the env carries the bindings the offload needs;
 * callers fall back to per-target session rebuild otherwise (unit tests and
 * minimal envs).
 */
export function createIsolatedArtifactRebuildRunner(
	env: Env | undefined,
): IsolatedArtifactRebuildRunner | null {
	const namespace = (
		env as (Env & { REPO_SESSION?: DurableObjectNamespace }) | undefined
	)?.REPO_SESSION
	const stagingKv = (
		env as (Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }) | undefined
	)?.BUNDLE_ARTIFACTS_KV
	if (!namespace || !stagingKv) return null
	return {
		async touch(stagingKey) {
			const payload = await stagingKv.get(stagingKey, 'text')
			if (payload == null) return
			await stagingKv.put(stagingKey, payload, {
				expirationTtl: stagingTtlSeconds,
			})
		},
		async run(request) {
			// A fresh, user-namespaced id per target puts every heavy rebuild
			// in its own isolate. The instance never touches its Durable Object
			// storage, so nothing persists for the random name.
			const stub = namespace.get(
				namespace.idFromName(
					`isolated-artifact-rebuild-${request.userId}-${crypto.randomUUID()}`,
				),
			) as unknown as IsolatedArtifactRebuildStub
			try {
				return await stub.runIsolatedArtifactRebuild(request)
			} catch (error) {
				if (isDurableObjectResourceLimitResetError(error)) {
					return {
						ok: false,
						message:
							`Artifact rebuild for { ${describeTarget(request.target)} } ` +
							"exceeded the isolated rebuild runner's memory or CPU limits " +
							'even on its own. Reduce the package source size (split large ' +
							'generated modules, remove vendored or data files) and re-run ' +
							'the publish capability to repair artifacts.',
						target: request.target,
					}
				}
				throw error
			}
		},
		async discard(stagingKey) {
			try {
				await stagingKv.delete(stagingKey)
			} catch {
				// Best effort: the staging entry expires via its TTL anyway.
			}
		},
	}
}

export { stagingTtlSeconds as isolatedArtifactRebuildStagingTtlSeconds }
