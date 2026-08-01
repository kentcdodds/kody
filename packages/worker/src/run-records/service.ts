import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { runLogDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	type ActivationMilestone,
	type ActivationMilestoneRecord,
	type ActivationStateImport,
	type PackageRunSuccessRecord,
	countsTowardPackageActivation,
} from './package-activation-state.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilitySeedInput,
	type JobRunObservabilityStatus,
	type JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
import {
	type PackageInvocationClaimInput,
	type PackageInvocationLedgerKey,
	type PackageInvocationLedgerRecord,
	type RunLogEntryInput,
	type RunLogRowInput,
	type RunLogRpc,
} from './run-log-do.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionReserveResult,
	type WorkflowProjectionUpsertInput,
	workflowProjectionImportMaxBatch,
} from './workflow-projection.ts'
import {
	type RunRecord,
	type RunRecordContext,
	type RunRecordFilter,
	type RunRecordHandle,
	type RunLogLevel,
	type RunRecordLog,
	type RunRecordLogInput,
	type RunRecordPage,
	type RunRecordSummary,
	type RunStatus,
	type RunTerminalStatus,
	runLogLevelValues,
	runPersistenceForContext,
	runRecordDefaultPageSize,
	runRecordMaxJsonBytes,
	runRecordMaxLogEntriesPerRun,
	runRecordMaxPageSize,
	runRecordMaxResultSnapshotBytes,
	runRecordMaxTextBytes,
} from './types.ts'

const textEncoder = new TextEncoder()

function normalizeOptionalString(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

function truncateUtf8(value: string, maxBytes: number) {
	if (textEncoder.encode(value).length <= maxBytes) return value
	const suffix = '... [truncated]'
	let low = 0
	let high = value.length
	let best = ''
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2)
		const candidate = `${value.slice(0, midpoint)}${suffix}`
		if (textEncoder.encode(candidate).length <= maxBytes) {
			best = candidate
			low = midpoint + 1
		} else {
			high = midpoint - 1
		}
	}
	return best
}

function serializeJson(value: unknown, maxBytes = runRecordMaxJsonBytes) {
	const json = JSON.stringify(toJsonSafeValue(value))
	if (textEncoder.encode(json).length <= maxBytes) return json
	let preview = truncateUtf8(json, Math.max(0, maxBytes - 128))
	let wrapped = JSON.stringify({
		__truncated__: true,
		preview,
	})
	while (textEncoder.encode(wrapped).length > maxBytes && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length * 0.8))
		wrapped = JSON.stringify({
			__truncated__: true,
			preview,
		})
	}
	return wrapped
}

/**
 * Bound a JSON-serializable handler result for `metadata.result`. Oversized
 * values become `{ __truncated__: true, preview }` so `run_get` stays useful
 * without blowing per-user DO storage.
 */
export function snapshotRunRecordResult(
	value: unknown,
	maxBytes = runRecordMaxResultSnapshotBytes,
): unknown {
	const safe = toJsonSafeValue(value)
	const json = JSON.stringify(safe)
	if (textEncoder.encode(json).length <= maxBytes) return safe
	let preview = truncateUtf8(json, Math.max(0, maxBytes - 64))
	let wrapped: { __truncated__: true; preview: string } = {
		__truncated__: true,
		preview,
	}
	while (
		textEncoder.encode(JSON.stringify(wrapped)).length > maxBytes &&
		preview.length > 0
	) {
		preview = preview.slice(0, Math.floor(preview.length * 0.8))
		wrapped = { __truncated__: true, preview }
	}
	return wrapped
}

function getErrorFields(error: unknown) {
	if (!error) return { errorName: null, errorMessage: null }
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: truncateUtf8(error.message, runRecordMaxTextBytes),
		}
	}
	if (typeof error === 'object' && error !== null) {
		const record = error as Record<string, unknown>
		const message = record['message']
		if (typeof message === 'string') {
			const name = record['name']
			return {
				errorName: typeof name === 'string' ? name : 'Error',
				errorMessage: truncateUtf8(message, runRecordMaxTextBytes),
			}
		}
	}
	return {
		errorName: 'Unknown',
		errorMessage: truncateUtf8(String(error), runRecordMaxTextBytes),
	}
}

/**
 * The sandbox executor flattens console output to strings and encodes the
 * level as a leading `[warn] ` / `[error] ` marker. Recover the structured
 * level so readers can filter and colour by it instead of pattern-matching
 * message text.
 */
function splitLeveledLogMessage(message: string): {
	level: RunLogLevel
	message: string
} {
	for (const level of runLogLevelValues) {
		const marker = `[${level}] `
		if (message.startsWith(marker)) {
			return { level, message: message.slice(marker.length) }
		}
	}
	return { level: 'log', message }
}

function normalizeLogs(
	logs: Array<RunRecordLogInput> | undefined,
): Array<RunLogEntryInput> {
	return (logs ?? [])
		.slice(-runRecordMaxLogEntriesPerRun)
		.map((entry, index) => {
			if (typeof entry === 'string') {
				const split = splitLeveledLogMessage(String(entry))
				return {
					sequence: index,
					level: split.level,
					message: truncateUtf8(split.message, runRecordMaxTextBytes),
					fieldsJson: null,
				}
			}
			return {
				sequence: index,
				level: entry.level ?? 'log',
				message: truncateUtf8(String(entry.message), runRecordMaxTextBytes),
				fieldsJson: entry.fields == null ? null : serializeJson(entry.fields),
			}
		})
}

function buildRunRow(input: {
	handle: RunRecordHandle
	status: RunStatus
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	updatedAt: string
}): RunLogRowInput {
	const context = input.handle.context
	return {
		id: input.handle.id,
		surface: context.surface,
		status: input.status,
		name: normalizeOptionalString(context.name),
		packageId: normalizeOptionalString(context.packageId),
		kodyId: normalizeOptionalString(context.kodyId),
		sourceId: normalizeOptionalString(context.sourceId),
		publishedCommit: normalizeOptionalString(context.publishedCommit),
		storageId: normalizeOptionalString(context.storageId),
		jobId: normalizeOptionalString(context.jobId),
		workflowId: normalizeOptionalString(context.workflowId),
		invocationId: normalizeOptionalString(context.invocationId),
		sessionId: normalizeOptionalString(context.sessionId),
		idempotencyKey: normalizeOptionalString(context.idempotencyKey),
		parentRunId: normalizeOptionalString(context.parentRunId),
		startedAt: input.handle.startedAt,
		finishedAt: input.finishedAt,
		durationMs: input.durationMs,
		errorName: input.errorName,
		errorMessage: input.errorMessage,
		metadataJson: serializeJson(context.metadata ?? {}),
		createdAt: input.handle.startedAt,
		updatedAt: input.updatedAt,
	}
}

function runLogBinding(env: Env) {
	return (env as Partial<Env>).RUN_LOG ?? null
}

export function runLogRpc(input: { env: Env; userId: string }): RunLogRpc {
	const namespace = runLogBinding(input.env)
	if (!namespace) {
		throw new Error('RUN_LOG Durable Object binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(runLogDurableObjectName(input.userId)),
	) as unknown as RunLogRpc
}

/**
 * Never throws: a run record is observability, so a broken record must not
 * fail the run it observes. Callers treat a `null` handle as "not recording"
 * and keep going. Same contract as `recordUsage`.
 */
export function beginRunRecord(input: {
	env: Env
	userId?: string | null
	context?: RunRecordContext | null
	waitUntil?: (promise: Promise<unknown>) => void
}): RunRecordHandle | null {
	const namespace = runLogBinding(input.env)
	const userId = normalizeOptionalString(input.userId ?? undefined)
	const context = input.context
	if (!namespace || !userId || !context) return null

	try {
		const id = crypto.randomUUID()
		const startedAt = new Date().toISOString()
		const persistence = runPersistenceForContext(context)
		const handle: RunRecordHandle = {
			id,
			userId,
			startedAt,
			persistence,
			context,
		}

		if (persistence === 'eager') {
			const run = buildRunRow({
				handle,
				status: 'running',
				finishedAt: null,
				durationMs: null,
				errorName: null,
				errorMessage: null,
				updatedAt: startedAt,
			})
			// A dropped startRun is deliberately harmless: finishRun upserts the
			// complete row. That is why begin can stay off the request critical path.
			// Keyed execute must use {@link claimRunRecord} instead so the running
			// row is visible before work starts (replay / in-progress lookups).
			const startPromise = runLogRpc({ env: input.env, userId })
				.startRun({ run })
				.catch((error: unknown) => {
					console.warn('run-record-start-failed', error)
				})
			if (input.waitUntil) {
				input.waitUntil(startPromise)
			} else {
				void startPromise
			}
		}

		return handle
	} catch (error) {
		console.warn('run-record-begin-failed', error)
		return null
	}
}

/**
 * Awaited claim for keyed runs (execute with `idempotencyKey`). Returns the
 * existing owner when the key is already taken so callers can replay or report
 * in-progress without starting a duplicate sandbox.
 *
 * Never throws: same observability contract as {@link beginRunRecord}.
 */
export async function claimRunRecord(input: {
	env: Env
	userId?: string | null
	context?: RunRecordContext | null
}): Promise<
	| { claimed: true; handle: RunRecordHandle }
	| { claimed: false; run: RunRecord }
	| null
> {
	const namespace = runLogBinding(input.env)
	const userId = normalizeOptionalString(input.userId ?? undefined)
	const context = input.context
	if (!namespace || !userId || !context) return null
	const idempotencyKey = normalizeOptionalString(context.idempotencyKey)
	if (!idempotencyKey) return null

	try {
		const startedAt = new Date().toISOString()
		const handle: RunRecordHandle = {
			id: crypto.randomUUID(),
			userId,
			startedAt,
			persistence: runPersistenceForContext({
				...context,
				idempotencyKey,
			}),
			context: {
				...context,
				idempotencyKey,
			},
		}
		const run = buildRunRow({
			handle,
			status: 'running',
			finishedAt: null,
			durationMs: null,
			errorName: null,
			errorMessage: null,
			updatedAt: startedAt,
		})
		const claimed = await runLogRpc({ env: input.env, userId }).claimRun({
			run,
		})
		if (!claimed.claimed) {
			return { claimed: false, run: claimed.run }
		}
		return { claimed: true, handle }
	} catch (error) {
		console.warn('run-record-claim-failed', error)
		return null
	}
}

/**
 * Lazily seed RunLog activation counters/milestones from D1 exactly once per
 * user. Never throws. D1 query failures leave the DO uninitialized so a later
 * successful read can merge; successful empty (including missing APP_DB) still
 * marks initialized.
 */
export async function ensureActivationStateSeeded(input: {
	env: Env
	userId: string
}): Promise<void> {
	if (!runLogBinding(input.env)) return
	try {
		const rpc = runLogRpc({ env: input.env, userId: input.userId })
		const { initialized } = await rpc.isActivationInitialized()
		if (initialized) return
		const snapshot = await readActivationStateFromD1({
			env: input.env,
			userId: input.userId,
		})
		if (!snapshot.ok) {
			console.warn('run-log-activation-seed-failed', snapshot.error)
			return
		}
		await rpc.importActivationState(snapshot.value)
	} catch (error) {
		console.warn('run-log-activation-seed-failed', error)
	}
}

/**
 * Lazily seed one job's observability from D1 exactly once (`legacy_seeded`).
 * Never throws. D1 query failures skip seeding so a later success can merge
 * into counters created by post-cutover finishes; successful empty marks
 * `legacy_seeded` with zeros.
 */
export async function ensureJobRunObservabilitySeeded(input: {
	env: Env
	userId: string
	jobId: string
}): Promise<void> {
	const jobId = normalizeOptionalString(input.jobId)
	if (!runLogBinding(input.env) || !jobId) return
	try {
		const rpc = runLogRpc({ env: input.env, userId: input.userId })
		const existing = await rpc.getJobRunObservability({ jobId })
		if (existing?.legacySeeded) return
		const read = await readJobRunObservabilityFromD1({
			env: input.env,
			userId: input.userId,
			jobId,
		})
		if (!read.ok) {
			console.warn('run-log-job-observability-seed-failed', read.error)
			return
		}
		const seed =
			read.value ??
			({
				jobId,
				lastRunAt: null,
				lastRunStatus: null,
				lastRunError: null,
				lastDurationMs: null,
				runCount: 0,
				successCount: 0,
				errorCount: 0,
				updatedAt: new Date().toISOString(),
			} satisfies JobRunObservabilitySeedInput)
		await rpc.seedJobRunObservabilityIfAbsent(seed)
	} catch (error) {
		console.warn('run-log-job-observability-seed-failed', error)
	}
}

type D1ReadResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Schema-not-ready (missing table or column) is a successful empty legacy
 * snapshot, not a retryable read failure — later contract-phase drops must not
 * leave the DO uninitialized forever.
 */
export function isMissingD1RelationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return /no such (table|column)/i.test(message)
}

async function readActivationStateFromD1(input: {
	env: Env
	userId: string
}): Promise<D1ReadResult<ActivationStateImport>> {
	const empty: ActivationStateImport = {
		packageRunSuccesses: [],
		milestones: [],
	}
	const db = input.env.APP_DB
	if (!db) return { ok: true, value: empty }
	try {
		const successRows = await db
			.prepare(
				`SELECT package_id, success_count, updated_at
				FROM user_package_run_successes
				WHERE user_id = ?
				ORDER BY package_id ASC`,
			)
			.bind(input.userId)
			.all<{
				package_id: string
				success_count: number
				updated_at: string
			}>()
		const milestoneRows = await db
			.prepare(
				`SELECT milestone, reached_at, package_id
				FROM user_activation_milestones
				WHERE user_id = ?
				ORDER BY milestone ASC`,
			)
			.bind(input.userId)
			.all<{
				milestone: string
				reached_at: string
				package_id: string | null
			}>()
		return {
			ok: true,
			value: {
				packageRunSuccesses: (successRows.results ?? []).map((row) => ({
					packageId: String(row.package_id),
					successCount: Number(row.success_count) || 0,
					updatedAt: String(row.updated_at),
				})),
				milestones: (milestoneRows.results ?? [])
					.filter(
						(row) =>
							row.milestone === 'package_run_succeeded' ||
							row.milestone === 'package_activated',
					)
					.map((row) => ({
						milestone: row.milestone as ActivationMilestone,
						reachedAt: String(row.reached_at),
						packageId: row.package_id == null ? null : String(row.package_id),
					})),
			},
		}
	} catch (error) {
		if (isMissingD1RelationError(error)) {
			return { ok: true, value: empty }
		}
		// Transient / unexpected D1 failure: do not mark initialized.
		return { ok: false, error }
	}
}

async function readJobRunObservabilityFromD1(input: {
	env: Env
	userId: string
	jobId: string
}): Promise<D1ReadResult<JobRunObservabilitySeedInput | null>> {
	const db = input.env.APP_DB
	if (!db) return { ok: true, value: null }
	try {
		const row = await db
			.prepare(
				`SELECT id, last_run_at, last_run_status, last_run_error, last_duration_ms,
					run_count, success_count, error_count, updated_at
				FROM jobs
				WHERE id = ? AND user_id = ?
				LIMIT 1`,
			)
			.bind(input.jobId, input.userId)
			.first<{
				id: string
				last_run_at: string | null
				last_run_status: string | null
				last_run_error: string | null
				last_duration_ms: number | null
				run_count: number
				success_count: number
				error_count: number
				updated_at: string
			}>()
		if (!row) return { ok: true, value: null }
		const lastRunStatus: JobRunObservabilityStatus | null =
			row.last_run_status === 'success' || row.last_run_status === 'error'
				? row.last_run_status
				: null
		return {
			ok: true,
			value: {
				jobId: String(row.id),
				lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
				lastRunStatus,
				lastRunError:
					row.last_run_error == null ? null : String(row.last_run_error),
				lastDurationMs:
					row.last_duration_ms == null
						? null
						: Number(row.last_duration_ms) || 0,
				runCount: Number(row.run_count) || 0,
				successCount: Number(row.success_count) || 0,
				errorCount: Number(row.error_count) || 0,
				updatedAt: String(row.updated_at),
			},
		}
	} catch (error) {
		if (isMissingD1RelationError(error)) {
			return { ok: true, value: null }
		}
		return { ok: false, error }
	}
}

async function prepareTerminalRunSideEffectSeeds(input: {
	env: Env
	userId: string
	status: RunTerminalStatus
	context: RunRecordContext
}): Promise<void> {
	const jobId = normalizeOptionalString(input.context.jobId)
	if (jobId) {
		await ensureJobRunObservabilitySeeded({
			env: input.env,
			userId: input.userId,
			jobId,
		})
	}
	if (
		input.status === 'success' &&
		normalizeOptionalString(input.context.packageId) &&
		countsTowardPackageActivation(input.context.surface)
	) {
		await ensureActivationStateSeeded({
			env: input.env,
			userId: input.userId,
		})
	}
}

/**
 * Never throws: a broken record or activation seed must not fail the observed
 * run. Historical D1 activation/job counters are seeded before the DO finish
 * so the terminal increment continues from the pre-cutover baseline.
 */
export async function finishRunRecord(input: {
	env: Env
	handle: RunRecordHandle | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	/**
	 * Optional JSON-serializable handler result retained under
	 * `metadata.result` (bounded; see {@link snapshotRunRecordResult}).
	 */
	result?: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<void> {
	const handle = input.handle
	if (!handle) return
	if (handle.persistence === 'on-failure' && input.status === 'success') {
		return
	}

	const work = (async () => {
		let persistedRun: RunLogRowInput | null = null
		try {
			if (runLogBinding(input.env)) {
				await prepareTerminalRunSideEffectSeeds({
					env: input.env,
					userId: handle.userId,
					status: input.status,
					context: handle.context,
				})
				const finishedAt = new Date().toISOString()
				const durationMs = Math.max(
					0,
					Date.parse(finishedAt) - Date.parse(handle.startedAt),
				)
				const { errorName, errorMessage } = getErrorFields(input.error)
				const metadata =
					input.result === undefined
						? handle.context.metadata
						: {
								...(handle.context.metadata ?? {}),
								result: snapshotRunRecordResult(input.result),
							}
				const run = buildRunRow({
					handle: {
						...handle,
						context: {
							...handle.context,
							metadata,
						},
					},
					status: input.status,
					finishedAt,
					durationMs,
					errorName,
					errorMessage,
					updatedAt: finishedAt,
				})
				await runLogRpc({ env: input.env, userId: handle.userId }).finishRun({
					run,
					logs: normalizeLogs(input.logs),
				})
				persistedRun = run
			}
		} catch (error) {
			console.warn('run-record-finish-failed', error)
		}

		if (
			persistedRun &&
			input.status === 'error' &&
			handle.context.surface !== 'subscription'
		) {
			try {
				// Dynamic import: a static edge to package-subscriptions pulls
				// package-invocations and deepens the account-export cycle
				// (account-export → … → account-export-shared → account-export),
				// leaving z.enum(accountExportSectionNames) undefined at module load.
				const { dispatchRunErrorSubscriptionEvents } =
					await import('./package-subscriptions.ts')
				await dispatchRunErrorSubscriptionEvents({
					env: input.env,
					userId: handle.userId,
					run: persistedRun,
					waitUntil: input.waitUntil,
				})
			} catch (error) {
				console.warn('run-error-subscription-dispatch-failed', error)
			}
		}
	})()

	if (input.waitUntil) {
		input.waitUntil(work)
		return
	}
	await work
}

/**
 * One-RPC terminal write for callers that have no work between begin and
 * finish. Equivalent to minting a handle and calling `finishRunRecord` without
 * `beginRunRecord` (finish already upserts a complete row). Prefer this over a
 * no-op begin when the surface is known to be terminal-only.
 */
export async function recordRunRecord(input: {
	env: Env
	userId?: string | null
	context?: RunRecordContext | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	result?: unknown
	startedAt?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<RunRecordHandle | null> {
	const namespace = runLogBinding(input.env)
	const userId = normalizeOptionalString(input.userId ?? undefined)
	const context = input.context
	if (!namespace || !userId || !context) return null

	let handle: RunRecordHandle
	try {
		handle = {
			id: crypto.randomUUID(),
			userId,
			startedAt:
				normalizeOptionalString(input.startedAt) ?? new Date().toISOString(),
			persistence: runPersistenceForContext(context),
			context,
		}
	} catch (error) {
		console.warn('run-record-begin-failed', error)
		return null
	}
	await finishRunRecord({
		env: input.env,
		handle,
		status: input.status,
		logs: input.logs,
		error: input.error,
		result: input.result,
		waitUntil: input.waitUntil,
	})
	return handle
}

export async function listRunRecords(input: {
	env: Env
	userId: string
	filter?: RunRecordFilter | null
	limit?: number | null
	cursor?: string | null
}): Promise<RunRecordPage> {
	if (!runLogBinding(input.env)) {
		return { runs: [], nextCursor: null }
	}
	const limit = Math.min(
		Math.max(input.limit ?? runRecordDefaultPageSize, 1),
		runRecordMaxPageSize,
	)
	return await runLogRpc({ env: input.env, userId: input.userId }).listRuns({
		surface: input.filter?.surface ?? null,
		status: input.filter?.status ?? null,
		packageId: normalizeOptionalString(input.filter?.packageId),
		jobId: normalizeOptionalString(input.filter?.jobId),
		name: normalizeOptionalString(input.filter?.name),
		since: normalizeOptionalString(input.filter?.since),
		limit,
		cursor: input.cursor ?? null,
	})
}

export async function getRunRecord(input: {
	env: Env
	userId: string
	runId: string
}): Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null> {
	if (!runLogBinding(input.env)) return null
	return await runLogRpc({ env: input.env, userId: input.userId }).getRun({
		runId: input.runId,
	})
}

export async function getRunRecordByIdempotencyKey(input: {
	env: Env
	userId: string
	idempotencyKey: string
	surface?: RunRecordContext['surface'] | null
}): Promise<RunRecord | null> {
	const key = normalizeOptionalString(input.idempotencyKey)
	if (!runLogBinding(input.env) || !key) return null
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getRunByIdempotencyKey({
		idempotencyKey: key,
		surface: input.surface ?? null,
	})
}

/**
 * Release a claimed `running` row after setup failure (before sandbox work).
 * Never throws. Terminal rows are left alone so legitimate finishes stay put.
 */
export async function abandonRunRecord(input: {
	env: Env
	handle: RunRecordHandle | null
}): Promise<void> {
	const handle = input.handle
	if (!handle || !runLogBinding(input.env)) return
	try {
		await runLogRpc({
			env: input.env,
			userId: handle.userId,
		}).deleteRunIfRunning({ runId: handle.id })
	} catch (error) {
		console.warn('run-record-abandon-failed', error)
	}
}

/**
 * Claim a keyed package invocation: idempotency-ledger claim plus eager
 * run-record begin in ONE awaited on-path DO RPC. Unlike {@link beginRunRecord}
 * this is correctness, not observability — a failed claim must fail the
 * invocation — so errors propagate to the caller instead of being swallowed.
 */
export async function claimPackageInvocationRecord(input: {
	env: Env
	userId: string
	/** `null` when the caller owns the run record (workflow-sourced invokes). */
	context: RunRecordContext | null
	invocation: PackageInvocationClaimInput
	/** ISO cutoff for in-place stale `in_progress` reclaims. */
	staleBefore: string
}): Promise<
	| {
			outcome: 'claimed'
			invocationId: string
			claimUpdatedAt: string
			reclaimed: boolean
			handle: RunRecordHandle | null
	  }
	| { outcome: 'existing'; record: PackageInvocationLedgerRecord }
> {
	let handle: RunRecordHandle | null = null
	let run: RunLogRowInput | null = null
	if (input.context) {
		const startedAt = new Date().toISOString()
		handle = {
			id: crypto.randomUUID(),
			userId: input.userId,
			startedAt,
			persistence: runPersistenceForContext(input.context),
			context: input.context,
		}
		run = buildRunRow({
			handle,
			status: 'running',
			finishedAt: null,
			durationMs: null,
			errorName: null,
			errorMessage: null,
			updatedAt: startedAt,
		})
	}
	const claimed = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).claimPackageInvocation({
		invocation: input.invocation,
		staleBefore: input.staleBefore,
		run,
	})
	if (claimed.outcome === 'existing') {
		return claimed
	}
	if (handle) {
		// Stale reclaims keep the original ledger row id; the run record must
		// reference the invocation id that actually owns the claim.
		handle.context = { ...handle.context, invocationId: claimed.invocationId }
	}
	return { ...claimed, handle }
}

export async function getPackageInvocationRecord(input: {
	env: Env
	userId: string
	key: PackageInvocationLedgerKey
}): Promise<PackageInvocationLedgerRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getPackageInvocation(input.key)
}

/**
 * Terminal ledger response and run-record finish in ONE awaited on-path DO
 * RPC — the counterpart to {@link claimPackageInvocationRecord}. RPC failures
 * propagate (the caller decides whether a lost terminal write may poison the
 * key); run-error subscription side effects shared with
 * {@link finishRunRecord} never throw and are scheduled on `waitUntil` when
 * provided.
 */
export async function finishPackageInvocationRecord(input: {
	env: Env
	userId: string
	handle: RunRecordHandle | null
	invocationId: string
	claimUpdatedAt: string
	ledgerStatus: 'completed' | 'failed'
	/** Bounded replay cache JSON; `null` drops the replay (oversized). */
	responseJson: string | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	result?: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	ledgerUpdated: boolean
	record: PackageInvocationLedgerRecord | null
}> {
	const handle = input.handle
	let run: RunLogRowInput | null = null
	if (handle) {
		await prepareTerminalRunSideEffectSeeds({
			env: input.env,
			userId: input.userId,
			status: input.status,
			context: handle.context,
		})
		const finishedAt = new Date().toISOString()
		const durationMs = Math.max(
			0,
			Date.parse(finishedAt) - Date.parse(handle.startedAt),
		)
		const { errorName, errorMessage } = getErrorFields(input.error)
		const metadata =
			input.result === undefined
				? handle.context.metadata
				: {
						...(handle.context.metadata ?? {}),
						result: snapshotRunRecordResult(input.result),
					}
		run = buildRunRow({
			handle: {
				...handle,
				context: {
					...handle.context,
					metadata,
				},
			},
			status: input.status,
			finishedAt,
			durationMs,
			errorName,
			errorMessage,
			updatedAt: finishedAt,
		})
	}
	const finished = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).finishPackageInvocation({
		invocationId: input.invocationId,
		claimUpdatedAt: input.claimUpdatedAt,
		status: input.ledgerStatus,
		responseJson: input.responseJson,
		run,
		logs: run ? normalizeLogs(input.logs) : [],
	})
	if (handle && run) {
		const sideEffects = dispatchTerminalRunRecordSideEffects({
			env: input.env,
			handle,
			persistedRun: run,
			status: input.status,
			waitUntil: input.waitUntil,
		})
		if (input.waitUntil) {
			input.waitUntil(sideEffects)
		} else {
			await sideEffects
		}
	}
	return finished
}

/**
 * Release a claim whose execution never started (transient artifact failure
 * or the dual-read D1 fallback finding a pre-migration owner). Deletes the
 * still-`in_progress` ledger row and the attempt's `running` run row.
 */
export async function releasePackageInvocationRecord(input: {
	env: Env
	userId: string
	invocationId: string
	claimUpdatedAt: string
	handle: RunRecordHandle | null
}): Promise<{
	released: boolean
	record: PackageInvocationLedgerRecord | null
}> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).releasePackageInvocation({
		invocationId: input.invocationId,
		claimUpdatedAt: input.claimUpdatedAt,
		runId: input.handle?.id ?? null,
	})
}

/**
 * Post-terminal-write observers shared by {@link finishRunRecord} and
 * {@link finishPackageInvocationRecord}: best-effort `run.error.recorded`
 * dispatch on error. Never throws.
 */
async function dispatchTerminalRunRecordSideEffects(input: {
	env: Env
	handle: RunRecordHandle
	persistedRun: RunLogRowInput
	status: RunTerminalStatus
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<void> {
	if (input.status !== 'error') return
	if (input.handle.context.surface === 'subscription') return
	try {
		// Dynamic import: a static edge to package-subscriptions pulls
		// package-invocations and deepens the account-export cycle (see the
		// matching note in finishRunRecord).
		const { dispatchRunErrorSubscriptionEvents } =
			await import('./package-subscriptions.ts')
		await dispatchRunErrorSubscriptionEvents({
			env: input.env,
			userId: input.handle.userId,
			run: input.persistedRun,
			waitUntil: input.waitUntil,
		})
	} catch (error) {
		console.warn('run-error-subscription-dispatch-failed', error)
	}
}

export async function summarizeRunRecords(input: {
	env: Env
	userId: string
	since?: string | null
}): Promise<RunRecordSummary> {
	const since =
		normalizeOptionalString(input.since) ?? new Date(0).toISOString()
	if (!runLogBinding(input.env)) {
		return {
			since,
			total: 0,
			errors: 0,
			running: 0,
			bySurface: [],
		}
	}
	return await runLogRpc({ env: input.env, userId: input.userId }).summarize({
		since,
	})
}

export async function listRunRecordStorageIds(input: {
	env: Env
	userId: string
}): Promise<Array<string>> {
	if (!runLogBinding(input.env)) return []
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).listStorageIds()
}

export async function exportRunRecords(input: {
	env: Env
	userId: string
	pageSize?: number
	startAfter?: string | null
}): Promise<{
	runs: Array<RunRecord>
	logs: Array<RunRecordLog>
	packageInvocations: Array<PackageInvocationLedgerRecord>
	workflowProjections: Array<WorkflowProjectionRecord>
	jobRunObservability: Array<JobRunObservabilityRecord>
	packageRunSuccesses: Array<PackageRunSuccessRecord>
	activationMilestones: Array<ActivationMilestoneRecord>
	nextStartAfter: string | null
	truncated: boolean
}> {
	if (!runLogBinding(input.env)) {
		return {
			runs: [],
			logs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			nextStartAfter: null,
			truncated: false,
		}
	}
	const page = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).exportRuns({
		pageSize: input.pageSize ?? runRecordDefaultPageSize,
		startAfter: input.startAfter ?? null,
	})
	return {
		...page,
		packageInvocations: page.packageInvocations ?? [],
		workflowProjections: page.workflowProjections ?? [],
		jobRunObservability: page.jobRunObservability ?? [],
		packageRunSuccesses: page.packageRunSuccesses ?? [],
		activationMilestones: page.activationMilestones ?? [],
	}
}

export async function clearRunRecords(input: {
	env: Env
	userId: string
}): Promise<void> {
	if (!runLogBinding(input.env)) return
	await runLogRpc({ env: input.env, userId: input.userId }).clearAll()
}

/**
 * Workflow projection writes/reads are correctness (idempotency + concurrent
 * workflow entitlements). Errors propagate to the caller.
 */
export async function upsertWorkflowProjection(input: {
	env: Env
	userId: string
	projection: WorkflowProjectionUpsertInput
}): Promise<{ ok: true }> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).upsertWorkflowProjection(input.projection)
}

/**
 * Batch expand-phase D1 → RunLog import in one DO RPC. Applies the same
 * monotonic + terminal-sticky upsert as {@link upsertWorkflowProjection}.
 * Hard-capped at {@link workflowProjectionImportMaxBatch}.
 */
export async function importWorkflowProjections(input: {
	env: Env
	userId: string
	projections: Array<WorkflowProjectionUpsertInput>
}): Promise<{ imported: number }> {
	const projections = input.projections.slice(
		0,
		workflowProjectionImportMaxBatch,
	)
	if (projections.length === 0) return { imported: 0 }
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).importWorkflowProjections({ projections })
}

export async function getWorkflowProjection(input: {
	env: Env
	userId: string
	id: string
}): Promise<WorkflowProjectionRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getWorkflowProjection({ id: input.id })
}

export async function findWorkflowProjectionByIdempotencyKey(input: {
	env: Env
	userId: string
	idempotencyKey: string
	bindingName?: string | null
}): Promise<WorkflowProjectionRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).findWorkflowProjectionByIdempotencyKey({
		idempotencyKey: input.idempotencyKey,
		bindingName: input.bindingName ?? null,
	})
}

/**
 * Exact binding + idempotency lookup that includes `creating` rows. Use this
 * instead of listing/scanning creating projections.
 */
export async function findWorkflowProjectionByBindingIdempotencyKey(input: {
	env: Env
	userId: string
	bindingName: string
	idempotencyKey: string
}): Promise<WorkflowProjectionRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).findWorkflowProjectionByBindingIdempotencyKey({
		bindingName: input.bindingName,
		idempotencyKey: input.idempotencyKey,
	})
}

export async function listWorkflowProjections(input: {
	env: Env
	userId: string
	limit?: number | null
	cursor?: string | null
	status?: string | null
	bindingName?: string | null
}): Promise<{
	projections: Array<WorkflowProjectionRecord>
	nextCursor: string | null
}> {
	const limit = Math.min(
		Math.max(input.limit ?? runRecordDefaultPageSize, 1),
		runRecordMaxPageSize,
	)
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).listWorkflowProjections({
		limit,
		cursor: input.cursor ?? null,
		status: input.status ?? null,
		bindingName: input.bindingName ?? null,
	})
}

export async function countActiveWorkflowProjections(input: {
	env: Env
	userId: string
}): Promise<number> {
	const result = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).countActiveWorkflowProjections()
	return result.count
}

export async function reserveWorkflowProjectionSlot(input: {
	env: Env
	userId: string
	projection: WorkflowProjectionUpsertInput
}): Promise<WorkflowProjectionReserveResult> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).reserveWorkflowProjectionSlot(input.projection)
}

export async function deleteWorkflowProjectionIfCreating(input: {
	env: Env
	userId: string
	id: string
}): Promise<{ deleted: boolean }> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).deleteWorkflowProjectionIfCreating({ id: input.id })
}

/**
 * Job-run observability is best-effort instrumentation. Never throws.
 */
export async function upsertJobRunObservability(input: {
	env: Env
	userId: string
	outcome: JobRunObservabilityUpsertInput
}): Promise<JobRunObservabilityRecord | null> {
	if (!runLogBinding(input.env)) return null
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).upsertJobRunObservability(input.outcome)
	} catch (error) {
		console.warn('job-run-observability-upsert-failed', error)
		return null
	}
}

export async function getJobRunObservability(input: {
	env: Env
	userId: string
	jobId: string
}): Promise<JobRunObservabilityRecord | null> {
	if (!runLogBinding(input.env)) return null
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).getJobRunObservability({ jobId: input.jobId })
	} catch (error) {
		console.warn('job-run-observability-get-failed', error)
		return null
	}
}

export async function getJobRunObservabilityBatch(input: {
	env: Env
	userId: string
	jobIds: Array<string>
}): Promise<Array<JobRunObservabilityRecord>> {
	if (!runLogBinding(input.env)) return []
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).getJobRunObservabilityBatch({ jobIds: input.jobIds })
	} catch (error) {
		console.warn('job-run-observability-batch-failed', error)
		return []
	}
}

/**
 * Activation reads are observability. Never throws. Writes happen atomically
 * inside terminal `finishRun` / `finishPackageInvocation`.
 */
export async function listPackageRunSuccesses(input: {
	env: Env
	userId: string
}): Promise<Array<PackageRunSuccessRecord>> {
	if (!runLogBinding(input.env)) return []
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).listPackageRunSuccesses()
	} catch (error) {
		console.warn('package-run-successes-list-failed', error)
		return []
	}
}

export async function listActivationMilestones(input: {
	env: Env
	userId: string
}): Promise<Array<ActivationMilestoneRecord>> {
	if (!runLogBinding(input.env)) return []
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).listActivationMilestones()
	} catch (error) {
		console.warn('activation-milestones-list-failed', error)
		return []
	}
}

export type { RunLogRpc }
export type {
	PackageInvocationClaimInput,
	PackageInvocationLedgerKey,
	PackageInvocationLedgerRecord,
	PackageInvocationLedgerStatus,
} from './run-log-do.ts'
export type {
	ActivationMilestone,
	ActivationMilestoneRecord,
	ActivationStateImport,
	PackageRunSuccessRecord,
} from './package-activation-state.ts'
export { countsTowardPackageActivation } from './package-activation-state.ts'
export type {
	JobRunObservabilityRecord,
	JobRunObservabilitySeedInput,
	JobRunObservabilityStatus,
	JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
export type {
	WorkflowBindingName,
	WorkflowProjectionRecord,
	WorkflowProjectionReserveResult,
	WorkflowProjectionSourceType,
	WorkflowProjectionUpsertInput,
} from './workflow-projection.ts'
export {
	creatingWorkflowProjectionStatus,
	isWorkflowBindingName,
	workflowBindingNames,
	workflowProjectionActiveStatuses,
	workflowProjectionCreatingTtlMs,
	workflowProjectionImportMaxBatch,
	workflowProjectionReservationStatuses,
} from './workflow-projection.ts'
