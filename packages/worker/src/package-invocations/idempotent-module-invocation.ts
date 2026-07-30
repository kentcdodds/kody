import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	type PackageInvocationActor,
	type PackageModuleSelector,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { createRequestHash, resolveExistingInvocation } from './idempotency.ts'
import { type ensureModuleArtifact } from './module-artifacts.ts'
import { runSavedPackageModuleOnce } from './module-execution.ts'
import { buildJsonErrorResponse } from './responses.ts'
import {
	getPackageInvocationByKey,
	insertPackageInvocationRow,
	releasePackageInvocationClaim,
	tryClaimStalePackageInvocation,
	updatePackageInvocationResult,
	type PackageInvocationStoredResponse,
} from './repo.ts'

export const packageInvocationStaleAfterMs = 15 * 60 * 1000
const packageInvocationPollIntervalMs = 100
const packageInvocationPollBudgetMs = 1_000

function isStaleInvocation(updatedAt: string, now: Date) {
	return Date.parse(updatedAt) <= now.getTime() - packageInvocationStaleAfterMs
}

/**
 * Keyed (exactly-once) invocation path: idempotency ledger claim, bounded
 * response replay, eager run records. Key-less callers take
 * `runSavedPackageModuleEphemeral` in module-execution.ts instead — the
 * execution itself is shared via `runSavedPackageModuleOnce`.
 */
export async function invokeSavedPackageModule(input: {
	env: Env
	baseUrl: string
	actor: PackageInvocationActor
	savedPackage: SavedPackageRecord
	invocationName: string
	moduleSelector: PackageModuleSelector
	params?: Record<string, unknown>
	idempotencyKey: string
	source: string | null
	topic: string | null
	notFoundCode: 'export_not_found' | 'subscription_not_found'
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Artifact already prepared by a `packages.invoke` check phase moments
	 * earlier; skips a second manifest + artifact load. The claim still
	 * happens first, so replay semantics are unchanged.
	 */
	preloadedModuleArtifact?: Awaited<
		ReturnType<typeof ensureModuleArtifact>
	> | null
	executorTimeoutMs?: number | null
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.actor.userId,
		async write() {
			const requestHash = await createRequestHash({
				packageId: input.savedPackage.id,
				exportName: input.invocationName,
				params: input.params,
				source: input.source,
				topic: input.topic,
			})
			const lookupInvocation = async () =>
				await getPackageInvocationByKey({
					db: input.env.APP_DB,
					userId: input.actor.userId,
					tokenId: input.actor.tokenId,
					packageId: input.savedPackage.id,
					exportName: input.invocationName,
					idempotencyKey: input.idempotencyKey,
				})
			let existing: Awaited<ReturnType<typeof getPackageInvocationByKey>>
			try {
				existing = await lookupInvocation()
			} catch (error) {
				console.error('package invocation idempotency lookup failed', error)
				return buildJsonErrorResponse({
					status: 500,
					code: 'idempotency_lookup_failed',
					message:
						'Unable to look up the package invocation idempotency record. Please retry.',
					idempotencyKey: input.idempotencyKey,
				})
			}
			let invocationId: string = crypto.randomUUID()
			let claimUpdatedAt: string | null = null
			if (existing) {
				if (
					existing.request_hash !== requestHash ||
					existing.status !== 'in_progress'
				) {
					return resolveExistingInvocation({
						record: existing,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				const pollDeadline = Date.now() + packageInvocationPollBudgetMs
				while (
					existing.status === 'in_progress' &&
					!isStaleInvocation(existing.updated_at, new Date()) &&
					Date.now() < pollDeadline
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, packageInvocationPollIntervalMs),
					)
					existing = await lookupInvocation()
					if (!existing) break
				}
				if (!existing) {
					return buildJsonErrorResponse({
						status: 500,
						code: 'idempotency_conflict_unresolved',
						message: 'Package invocation disappeared while polling.',
						idempotencyKey: input.idempotencyKey,
					})
				}
				if (existing.status !== 'in_progress') {
					return resolveExistingInvocation({
						record: existing,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				const now = new Date()
				if (!isStaleInvocation(existing.updated_at, now)) {
					return resolveExistingInvocation({
						record: existing,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				const reclaimedAt = now.toISOString()
				const reclaimed = await tryClaimStalePackageInvocation({
					db: input.env.APP_DB,
					id: existing.id,
					userId: input.actor.userId,
					expectedUpdatedAt: existing.updated_at,
					staleBefore: new Date(
						now.getTime() - packageInvocationStaleAfterMs,
					).toISOString(),
					now: reclaimedAt,
				})
				if (!reclaimed) {
					const current = await lookupInvocation()
					if (!current) {
						return buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_conflict_unresolved',
							message: 'Stale package invocation reclaim conflicted.',
							idempotencyKey: input.idempotencyKey,
						})
					}
					return resolveExistingInvocation({
						record: current,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				invocationId = existing.id
				claimUpdatedAt = reclaimedAt
			}

			if (!claimUpdatedAt) {
				let insertResult: Awaited<ReturnType<typeof insertPackageInvocationRow>>
				try {
					insertResult = await insertPackageInvocationRow({
						db: input.env.APP_DB,
						row: {
							id: invocationId,
							userId: input.actor.userId,
							tokenId: input.actor.tokenId,
							packageId: input.savedPackage.id,
							packageKodyId: input.savedPackage.kodyId,
							exportName: input.invocationName,
							idempotencyKey: input.idempotencyKey,
							requestHash,
							source: input.source,
							topic: input.topic,
							status: 'in_progress',
						},
					})
				} catch (error) {
					console.error(
						'package invocation idempotency persistence failed',
						error,
					)
					return buildJsonErrorResponse({
						status: 500,
						code: 'idempotency_persistence_failed',
						message:
							'Unable to persist the package invocation idempotency record. Please retry.',
						idempotencyKey: input.idempotencyKey,
					})
				}
				if (insertResult.inserted) {
					claimUpdatedAt = insertResult.claimUpdatedAt
				} else {
					let current: Awaited<ReturnType<typeof getPackageInvocationByKey>>
					try {
						current = await lookupInvocation()
					} catch (error) {
						console.error('package invocation idempotency lookup failed', error)
						return buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_lookup_failed',
							message:
								'Unable to look up the package invocation idempotency record. Please retry.',
							idempotencyKey: input.idempotencyKey,
						})
					}
					if (!current) {
						return buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_conflict_unresolved',
							message:
								'Package invocation idempotency insert conflicted but no existing row was found.',
							idempotencyKey: input.idempotencyKey,
						})
					}
					return resolveExistingInvocation({
						record: current,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
			}
			if (!claimUpdatedAt) {
				throw new Error(
					'Package invocation claim timestamp was not established.',
				)
			}
			const persistClaimedResult = async (
				status: 'completed' | 'failed',
				response: PackageInvocationStoredResponse,
			) => {
				const updated = await updatePackageInvocationResult({
					db: input.env.APP_DB,
					id: invocationId,
					userId: input.actor.userId,
					status,
					response,
					claimUpdatedAt,
				})
				if (updated) return response
				const current = await lookupInvocation()
				if (current) {
					return resolveExistingInvocation({
						record: current,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				return buildJsonErrorResponse({
					status: 500,
					code: 'idempotency_response_unavailable',
					message: 'Package invocation result lost its recovery claim.',
					idempotencyKey: input.idempotencyKey,
				})
			}

			const outcome = await runSavedPackageModuleOnce({
				env: input.env,
				baseUrl: input.baseUrl,
				actor: input.actor,
				savedPackage: input.savedPackage,
				invocationName: input.invocationName,
				moduleSelector: input.moduleSelector,
				params: input.params,
				idempotencyKey: input.idempotencyKey,
				invocationId,
				source: input.source,
				topic: input.topic,
				notFoundCode: input.notFoundCode,
				runtimeInvokeDepth: input.runtimeInvokeDepth,
				toolFactories: input.toolFactories,
				waitUntil: input.waitUntil,
				preloadedModuleArtifact: input.preloadedModuleArtifact,
				executorTimeoutMs: input.executorTimeoutMs,
			})
			switch (outcome.kind) {
				case 'artifact-unavailable': {
					const released = await releasePackageInvocationClaim({
						db: input.env.APP_DB,
						id: invocationId,
						userId: input.actor.userId,
						claimUpdatedAt,
					})
					if (!released) {
						const current = await lookupInvocation()
						if (current?.status !== 'in_progress') {
							return current
								? resolveExistingInvocation({
										record: current,
										requestHash,
										idempotencyKey: input.idempotencyKey,
									})
								: buildJsonErrorResponse({
										status: 500,
										code: 'idempotency_conflict_unresolved',
										message:
											'Transient artifact preparation lost its invocation claim.',
										idempotencyKey: input.idempotencyKey,
									})
						}
					}
					return outcome.response
				}
				case 'completed': {
					try {
						return await persistClaimedResult('completed', outcome.response)
					} catch (error) {
						// The module already succeeded; do not poison the key with a
						// stored permanent failure. Return the result to the caller and
						// leave the claim in progress so the stale-reclaim path decides
						// what happens on a later retry.
						console.warn(
							'package invocation completed-result persistence failed',
							getErrorMessage(error),
						)
						return outcome.response
					}
				}
				case 'failed': {
					return await persistClaimedResult('failed', outcome.response).catch(
						(error: unknown) => {
							// Best effort; preserve the original invocation error.
							console.warn(
								'package invocation terminal persistence failed',
								getErrorMessage(error),
							)
							return outcome.response
						},
					)
				}
				default: {
					const exhaustive: never = outcome
					void exhaustive
					throw new Error('Unhandled package module run outcome.')
				}
			}
		},
	})
}
