import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { recordSuccessfulPackageRun } from '#worker/usage/activation.ts'
import { runLogDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	type RunLogEntryInput,
	type RunLogRowInput,
	type RunLogRpc,
} from './run-log-do.ts'
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
 * Never throws, including the activation milestone write it fans out to: the
 * terminal record and the milestone both observe the run, so neither may fail
 * it.
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

		if (input.status === 'success') {
			const packageId = normalizeOptionalString(handle.context.packageId)
			if (packageId) {
				try {
					await recordSuccessfulPackageRun(input.env, {
						userId: handle.userId,
						packageId,
						surface: handle.context.surface,
					})
				} catch (error) {
					console.warn('run-record-activation-failed', error)
				}
			}
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
	nextStartAfter: string | null
	truncated: boolean
}> {
	if (!runLogBinding(input.env)) {
		return {
			runs: [],
			logs: [],
			nextStartAfter: null,
			truncated: false,
		}
	}
	return await runLogRpc({ env: input.env, userId: input.userId }).exportRuns({
		pageSize: input.pageSize ?? runRecordDefaultPageSize,
		startAfter: input.startAfter ?? null,
	})
}

export async function clearRunRecords(input: {
	env: Env
	userId: string
}): Promise<void> {
	if (!runLogBinding(input.env)) return
	await runLogRpc({ env: input.env, userId: input.userId }).clearAll()
}

export type { RunLogRpc }
