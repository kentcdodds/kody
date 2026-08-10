import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import {
	type PackageBundleTarget,
	type PackageCallableTypecheckTarget,
} from './checks.ts'

/**
 * Heavy repo-check phases (esbuild-wasm bundle validation, TypeScript
 * language-service typecheck) run in fresh, throwaway `REPO_SESSION`
 * isolates instead of the session/publish Durable Object. One large package
 * could otherwise push the session isolate (workspace + git state + checks)
 * over the Durable Object memory limit and kill every publish attempt
 * (kentcdodds/kody#987). Each phase invocation gets a brand-new DO id, so:
 *
 * - phases never stack their peak memory on top of the session isolate or
 *   each other (esbuild-wasm memory in particular never shrinks once grown),
 * - a package too large for even a single phase surfaces as a failed check
 *   with an actionable message instead of an opaque isolate reset, and
 * - the throwaway instances never touch their own Durable Object storage, so
 *   nothing persists for their random ids.
 *
 * The collected source files (bounded by the repo-check source caps) are
 * staged once in KV with a short TTL and fetched by each phase isolate;
 * the RPC payloads stay small.
 */

export const isolatedCheckStagingKeyPrefix = 'repo-checks-staging:v1:'
const stagingTtlSeconds = 15 * 60
/**
 * Bundle targets validated per throwaway isolate. Small enough that a chunk
 * stays far from the isolate memory limit, large enough to keep the isolate
 * fan-out modest for typical packages.
 */
export const isolatedBundleChunkSize = 4

export type IsolatedCheckPhaseRequest =
	| {
			phase: 'bundle-chunk'
			stagingKey: string
			baseUrl: string
			userId: string
			bundleTargets: Array<PackageBundleTarget>
	  }
	| {
			phase: 'typecheck'
			stagingKey: string
			userId: string
			typecheckTargets: Array<PackageCallableTypecheckTarget>
	  }

/**
 * Staged snapshots are user-owned content, so the staging key is namespaced
 * by `userId` and the consuming Durable Object verifies the key belongs to
 * the requesting user before reading it.
 */
export function isolatedCheckStagingKeyForUser(userId: string) {
	return `${isolatedCheckStagingKeyPrefix}${userId}:${crypto.randomUUID()}`
}

export function isolatedCheckStagingKeyBelongsToUser(input: {
	stagingKey: string
	userId: string
}) {
	return input.stagingKey.startsWith(
		`${isolatedCheckStagingKeyPrefix}${input.userId}:`,
	)
}

export type IsolatedCheckPhaseOutcome = {
	ok: boolean
	message: string
}

type IsolatedCheckPhaseStub = {
	runIsolatedCheckPhase(
		input: IsolatedCheckPhaseRequest,
	): Promise<IsolatedCheckPhaseOutcome>
}

export type IsolatedCheckPhaseRunner = {
	stage(input: {
		userId: string
		sourceFiles: Record<string, string>
	}): Promise<string>
	run(request: IsolatedCheckPhaseRequest): Promise<IsolatedCheckPhaseOutcome>
	discard(stagingKey: string): Promise<void>
}

function isDurableObjectResourceLimitResetError(error: unknown) {
	// Remap only memory/CPU limits. Deploy resets must keep propagating.
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

function phaseLabel(request: IsolatedCheckPhaseRequest) {
	return request.phase === 'bundle-chunk'
		? `Bundle validation for ${request.bundleTargets
				.map((target) => `"${target.path}"`)
				.join(', ')}`
		: 'The TypeScript typecheck'
}

/**
 * Returns a runner when the env carries the bindings the offload needs;
 * callers fall back to inline phase execution otherwise (unit tests and
 * minimal envs).
 */
export function createIsolatedCheckPhaseRunner(
	env: Env | undefined,
): IsolatedCheckPhaseRunner | null {
	const namespace = (
		env as (Env & { REPO_SESSION?: DurableObjectNamespace }) | undefined
	)?.REPO_SESSION
	const stagingKv = (
		env as (Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }) | undefined
	)?.BUNDLE_ARTIFACTS_KV
	if (!namespace || !stagingKv) return null
	return {
		async stage(input) {
			const stagingKey = isolatedCheckStagingKeyForUser(input.userId)
			await stagingKv.put(
				stagingKey,
				JSON.stringify({ sourceFiles: input.sourceFiles }),
				{
					expirationTtl: stagingTtlSeconds,
				},
			)
			return stagingKey
		},
		async run(request) {
			// A fresh, user-namespaced id per phase invocation puts every heavy
			// phase in its own isolate. The instance never touches its Durable
			// Object storage, so nothing persists for the random name.
			const stub = namespace.get(
				namespace.idFromName(
					`isolated-check-phase-${request.userId}-${crypto.randomUUID()}`,
				),
			) as unknown as IsolatedCheckPhaseStub
			try {
				return await stub.runIsolatedCheckPhase(request)
			} catch (error) {
				if (isDurableObjectResourceLimitResetError(error)) {
					return {
						ok: false,
						message:
							`${phaseLabel(request)} exceeded the isolated check runner's ` +
							'memory or CPU limits even on its own. Reduce the package ' +
							'source size (split large generated modules, remove vendored ' +
							'or data files) and run the checks again.',
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
