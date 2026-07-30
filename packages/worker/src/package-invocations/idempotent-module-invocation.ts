import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	claimPackageInvocationRecord,
	finishPackageInvocationRecord,
	getPackageInvocationRecord,
	releasePackageInvocationRecord,
	type PackageInvocationLedgerRecord,
} from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildPackageInvocationStorageId,
	resolveInvocationRuntimeName,
	resolveInvocationRuntimeSurface,
	type PackageInvocationActor,
	type PackageModuleSelector,
	type PackageRuntimeToolFactories,
} from './common.ts'
import {
	createRequestHash,
	resolveExistingInvocation,
	type ResolvableInvocationRecord,
} from './idempotency.ts'
import { type ensureModuleArtifact } from './module-artifacts.ts'
import { runSavedPackageModuleOnce } from './module-execution.ts'
import { buildJsonErrorResponse } from './responses.ts'
import { boundedResponseJson, parseStoredResponse } from './repo.ts'

export const packageInvocationStaleAfterMs = 15 * 60 * 1000
const packageInvocationPollIntervalMs = 100
const packageInvocationPollBudgetMs = 1_000

function isStaleInvocation(updatedAt: string, now: Date) {
	return Date.parse(updatedAt) <= now.getTime() - packageInvocationStaleAfterMs
}

function toResolvableLedgerRecord(
	record: PackageInvocationLedgerRecord,
): ResolvableInvocationRecord {
	return {
		requestHash: record.requestHash,
		status: record.status,
		storedResponse: parseStoredResponse(record.responseJson),
	}
}

type ClaimedInvocation = {
	invocationId: string
	claimUpdatedAt: string
	handle: RunRecordHandle | null
}

/**
 * Keyed (exactly-once) invocation path. The idempotency ledger lives in the
 * per-user RunLog Durable Object: the claim and the eager run-record begin
 * are one awaited DO call, and the terminal response and run-record finish
 * are one awaited DO call. Key-less callers take
 * `runSavedPackageModuleEphemeral` in module-execution.ts instead — the
 * execution itself is shared via `runSavedPackageModuleOnce`.
 *
 * The legacy D1 `package_invocations` table is retired: this path performs
 * no D1 ledger reads or writes at all. Keys claimed before the DO migration
 * no longer replay — a redelivery for such a key simply executes fresh
 * (accepted when the dual-read window was waived).
 *
 * This path deliberately takes no `withAccountWriteLease`: the lease guards
 * D1 writes against concurrent account deletion, and no D1 writes remain
 * here. D1 writes made by the executing package go through capability
 * services that hold their own leases — the same guard profile the key-less
 * lean path shipped with. The DO rows this path writes are purged by account
 * deletion's `clearRunRecords`, and a write racing past that purge is the
 * same accepted residual as every other run-record write, bounded by the
 * DO's own retention.
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
	const requestHash = await createRequestHash({
		packageId: input.savedPackage.id,
		exportName: input.invocationName,
		params: input.params,
		source: input.source,
		topic: input.topic,
	})
	const ledgerKey = {
		tokenId: input.actor.tokenId,
		packageId: input.savedPackage.id,
		exportName: input.invocationName,
		idempotencyKey: input.idempotencyKey,
	}

	const resolveLedgerRecord = (record: PackageInvocationLedgerRecord) =>
		resolveExistingInvocation({
			record: toResolvableLedgerRecord(record),
			requestHash,
			idempotencyKey: input.idempotencyKey,
		})
	const buildLookupFailedResponse = () =>
		buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_lookup_failed',
			message:
				'Unable to look up the package invocation idempotency record. Please retry.',
			idempotencyKey: input.idempotencyKey,
		})
	const buildPersistenceFailedResponse = () =>
		buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_persistence_failed',
			message:
				'Unable to persist the package invocation idempotency record. Please retry.',
			idempotencyKey: input.idempotencyKey,
		})

	const buildRunRecordContext = (): RunRecordContext | null => {
		const runtimeSurface = resolveInvocationRuntimeSurface({
			selector: input.moduleSelector,
			source: input.source,
		})
		// `null` surface: the caller (package-backed workflows) owns the run
		// record, so the claim writes only the ledger row.
		if (runtimeSurface == null) return null
		return {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
			// Known only after the artifact loads; module-execution enriches the
			// handle context before the terminal write.
			publishedCommit: null,
			storageId: buildPackageInvocationStorageId(input.savedPackage.id),
			surface: runtimeSurface,
			name: resolveInvocationRuntimeName({
				surface: runtimeSurface,
				invocationName: input.invocationName,
				topic: input.topic,
			}),
			invocationId: null,
			idempotencyKey: input.idempotencyKey,
			metadata: {
				exportName: input.invocationName,
				source: input.source,
				topic: input.topic,
			},
		}
	}

	const attemptClaim = async () =>
		await claimPackageInvocationRecord({
			env: input.env,
			userId: input.actor.userId,
			context: buildRunRecordContext(),
			invocation: {
				id: crypto.randomUUID(),
				...ledgerKey,
				packageKodyId: input.savedPackage.kodyId,
				requestHash,
				source: input.source,
				topic: input.topic,
			},
			staleBefore: new Date(
				Date.now() - packageInvocationStaleAfterMs,
			).toISOString(),
		})
	const lookupLedger = async () =>
		await getPackageInvocationRecord({
			env: input.env,
			userId: input.actor.userId,
			key: ledgerKey,
		})
	let claim: Awaited<ReturnType<typeof attemptClaim>>
	try {
		claim = await attemptClaim()
	} catch (error) {
		console.error('package invocation idempotency persistence failed', error)
		return buildPersistenceFailedResponse()
	}

	// Resolve an existing DO owner: mismatch and terminal rows resolve
	// immediately; fresh in-progress rows are polled within the budget; stale
	// in-progress rows are reclaimed atomically by a second claim call (which
	// loops back here when a competitor wins the reclaim).
	while (claim.outcome === 'existing') {
		let record: PackageInvocationLedgerRecord | null = claim.record
		if (record.requestHash !== requestHash || record.status !== 'in_progress') {
			return resolveLedgerRecord(record)
		}
		const pollDeadline = Date.now() + packageInvocationPollBudgetMs
		while (
			record &&
			record.status === 'in_progress' &&
			!isStaleInvocation(record.updatedAt, new Date()) &&
			Date.now() < pollDeadline
		) {
			await new Promise((resolve) =>
				setTimeout(resolve, packageInvocationPollIntervalMs),
			)
			try {
				record = await lookupLedger()
			} catch (error) {
				console.error('package invocation idempotency lookup failed', error)
				return buildLookupFailedResponse()
			}
		}
		if (!record) {
			// The owner released its claim (transient artifact failure) and the
			// key is free again; the caller retries rather than us re-claiming
			// mid-poll.
			return buildJsonErrorResponse({
				status: 500,
				code: 'idempotency_conflict_unresolved',
				message: 'Package invocation disappeared while polling.',
				idempotencyKey: input.idempotencyKey,
			})
		}
		if (record.status !== 'in_progress') {
			return resolveLedgerRecord(record)
		}
		if (!isStaleInvocation(record.updatedAt, new Date())) {
			return resolveLedgerRecord(record)
		}
		try {
			claim = await attemptClaim()
		} catch (error) {
			console.error('package invocation idempotency persistence failed', error)
			return buildPersistenceFailedResponse()
		}
	}

	const claimed: ClaimedInvocation = {
		invocationId: claim.invocationId,
		claimUpdatedAt: claim.claimUpdatedAt,
		handle: claim.handle,
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
		invocationId: claimed.invocationId,
		source: input.source,
		topic: input.topic,
		notFoundCode: input.notFoundCode,
		runtimeInvokeDepth: input.runtimeInvokeDepth,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
		preloadedModuleArtifact: input.preloadedModuleArtifact,
		executorTimeoutMs: input.executorTimeoutMs,
		externalRunRecordHandle: claimed.handle,
	})
	switch (outcome.kind) {
		case 'artifact-unavailable': {
			const release = await releasePackageInvocationRecord({
				env: input.env,
				userId: input.actor.userId,
				invocationId: claimed.invocationId,
				claimUpdatedAt: claimed.claimUpdatedAt,
				handle: claimed.handle,
			})
			if (!release.released) {
				const current = release.record
				if (current?.status !== 'in_progress') {
					return current
						? resolveLedgerRecord(current)
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
				const finished = await finishPackageInvocationRecord({
					env: input.env,
					userId: input.actor.userId,
					handle: claimed.handle,
					invocationId: claimed.invocationId,
					claimUpdatedAt: claimed.claimUpdatedAt,
					ledgerStatus: 'completed',
					responseJson: boundedResponseJson(outcome.response),
					status: 'success',
					logs: outcome.logs,
					result: outcome.result,
					waitUntil: input.waitUntil,
				})
				if (finished.ledgerUpdated) return outcome.response
				return finished.record
					? resolveLedgerRecord(finished.record)
					: buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_response_unavailable',
							message: 'Package invocation result lost its recovery claim.',
							idempotencyKey: input.idempotencyKey,
						})
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
			try {
				const finished = await finishPackageInvocationRecord({
					env: input.env,
					userId: input.actor.userId,
					handle: claimed.handle,
					invocationId: claimed.invocationId,
					claimUpdatedAt: claimed.claimUpdatedAt,
					ledgerStatus: 'failed',
					responseJson: boundedResponseJson(outcome.response),
					status: 'error',
					logs: outcome.logs,
					error: outcome.error,
					waitUntil: input.waitUntil,
				})
				if (finished.ledgerUpdated) return outcome.response
				return finished.record
					? resolveLedgerRecord(finished.record)
					: buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_response_unavailable',
							message: 'Package invocation result lost its recovery claim.',
							idempotencyKey: input.idempotencyKey,
						})
			} catch (error) {
				// Best effort; preserve the original invocation error.
				console.warn(
					'package invocation terminal persistence failed',
					getErrorMessage(error),
				)
				return outcome.response
			}
		}
		default: {
			const exhaustive: never = outcome
			void exhaustive
			throw new Error('Unhandled package module run outcome.')
		}
	}
}
