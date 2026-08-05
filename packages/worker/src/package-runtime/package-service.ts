import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	userMeterNamespace,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import {
	getPackageServiceEntryPath,
	listPackageServices,
} from '#worker/package-registry/manifest.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	recordUsage,
	type UsageEvent,
	type UsageOutcome,
} from '#worker/usage/record-usage.ts'
import { packageServiceInstanceDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'

const serviceStateStorageKey = 'package-service-state'
const packageServiceRetryDelayMs = 5_000
const packageServiceRetryMaxDelayMs = 15 * 60 * 1000
const requiredPackageServiceProjectionAttempts = 3
/**
 * How often a running service refreshes `package_service_states.updated_at`.
 * Must stay well below `packageServiceStateStaleMs` in entitlements so live
 * services are never dropped from the concurrency count.
 */
const packageServiceStateHeartbeatMs = 60 * 60 * 1000

export type PackageServiceBindingState = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
	serviceName: string
}

type PackageServiceProjectedStatus = 'running' | 'idle' | 'stopped' | 'error'

type PackageServiceState = {
	binding: PackageServiceBindingState | null
	autoStart: boolean
	mode: 'bounded' | 'persistent'
	timeoutMs: number | null
	stopRequested: boolean
	currentRunId: string | null
	nextAlarmAt: string | null
	nextAlarmSource: 'service' | 'auto-start' | 'heartbeat' | null
	lastStartedAt: string | null
	lastStoppedAt: string | null
	status: 'idle' | 'running' | 'stopping' | 'stopped' | 'error'
	lastError: string | null
	lastResult: unknown
	lastRunFinishedAt: string | null
	/**
	 * Consecutive failed runs (or failed auto-start attempts) since the last
	 * successful run. Persisted so Durable Object eviction does not reset the
	 * crash-loop backoff.
	 */
	consecutiveFailureCount: number
}

type PackageServiceRunResult = {
	ok: boolean
	run_id: string
	started_at: string
	status: 'running'
	already_running?: boolean
}

export const packageServiceStatusSchema = z.object({
	package_id: z.string(),
	kody_id: z.string(),
	service_name: z.string(),
	status: z.enum(['idle', 'running', 'stopping', 'stopped', 'error']),
	auto_start: z.boolean(),
	mode: z.enum(['bounded', 'persistent']),
	timeout_ms: z.number().int().positive().nullable(),
	stop_requested: z.boolean(),
	active_run_id: z.string().nullable(),
	next_alarm_at: z.string().nullable(),
	last_error: z.string().nullable(),
	last_started_at: z.string().nullable(),
	last_stopped_at: z.string().nullable(),
	last_run_finished_at: z.string().nullable(),
	last_result: z.unknown(),
})

export type PackageServiceStatusRecord = z.infer<
	typeof packageServiceStatusSchema
>

export function normalizePackageServiceStatus(
	input: unknown,
): PackageServiceStatusRecord {
	const result = packageServiceStatusSchema.safeParse(input)
	if (!result.success) {
		throw new Error(z.prettifyError(result.error))
	}
	return result.data
}

function createInitialPackageServiceState(): PackageServiceState {
	return {
		binding: null,
		autoStart: false,
		mode: 'bounded',
		timeoutMs: null,
		stopRequested: false,
		currentRunId: null,
		nextAlarmAt: null,
		nextAlarmSource: null,
		lastStartedAt: null,
		lastStoppedAt: null,
		status: 'idle',
		lastError: null,
		lastResult: null,
		lastRunFinishedAt: null,
		consecutiveFailureCount: 0,
	}
}

/**
 * Map DO status onto the D1 projection. `stopping` still holds a concurrency
 * slot until the run actually finishes, so it projects as `running`.
 */
export function projectPackageServiceStatus(
	status: PackageServiceState['status'],
): PackageServiceProjectedStatus {
	switch (status) {
		case 'running':
		case 'stopping':
			return 'running'
		case 'idle':
			return 'idle'
		case 'stopped':
			return 'stopped'
		case 'error':
			return 'error'
		default: {
			const exhaustive: never = status
			throw new Error(`Unknown package service status: ${String(exhaustive)}`)
		}
	}
}

export async function upsertPackageServiceState(input: {
	db: D1Database
	userId: string
	packageId: string
	serviceName: string
	status: PackageServiceProjectedStatus
	startedAt: string | null
	updatedAt: string
}): Promise<void> {
	await input.db
		.prepare(
			`INSERT INTO package_service_states (
				user_id, package_id, service_name, status, started_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, package_id, service_name) DO UPDATE SET
				status = excluded.status,
				started_at = excluded.started_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.packageId,
			input.serviceName,
			input.status,
			input.status === 'running' ? input.startedAt : null,
			input.updatedAt,
		)
		.run()
}

export async function deletePackageServiceState(input: {
	db: D1Database
	userId: string
	packageId: string
	serviceName: string
}): Promise<void> {
	await input.db
		.prepare(
			`DELETE FROM package_service_states
			WHERE user_id = ? AND package_id = ? AND service_name = ?`,
		)
		.bind(input.userId, input.packageId, input.serviceName)
		.run()
}

function getPackageServiceNamespace(env: Env) {
	return env.PACKAGE_SERVICE_INSTANCE
}

function getPackageServiceStub(input: {
	env: Env
	userId: string
	packageId: string
	serviceName: string
}) {
	const namespace = getPackageServiceNamespace(input.env)
	if (!namespace) {
		throw new Error('Missing PACKAGE_SERVICE_INSTANCE binding.')
	}
	const id = namespace.idFromName(
		packageServiceInstanceDurableObjectName({
			userId: input.userId,
			packageId: input.packageId,
			serviceName: input.serviceName,
		}),
	)
	return namespace.get(id)
}

export function buildPackageServiceStorageId(
	packageId: string,
	serviceName: string,
) {
	return `service:${encodeURIComponent(packageId)}:${encodeURIComponent(serviceName)}`
}

export function buildServiceRuntimeUsageEvent(input: {
	binding: PackageServiceBindingState
	startedAt: string | null
	/**
	 * `null` when the run's end time is unknown (a Durable Object eviction
	 * interrupted it); the event then carries no duration rather than an
	 * approximation.
	 */
	finishedAtMs: number | null
	failed: boolean
}): UsageEvent | null {
	if (!input.binding.userId || !input.startedAt) return null
	const startedAtMs = Date.parse(input.startedAt)
	if (Number.isNaN(startedAtMs)) return null
	const outcome: UsageOutcome = input.failed ? 'error' : 'success'
	return {
		userId: input.binding.userId,
		eventType: 'service_runtime',
		entityId: `${input.binding.packageId}:${input.binding.serviceName}`,
		...(input.finishedAtMs === null
			? {}
			: { durationMs: Math.max(0, input.finishedAtMs - startedAtMs) }),
		outcome,
	}
}

async function loadSavedPackageService(input: {
	env: Env
	binding: PackageServiceBindingState
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.binding.userId,
		packageId: input.binding.packageId,
	})
	if (!savedPackage) {
		throw new Error(
			'Saved package was not found for package service operations.',
		)
	}
	const packageSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.binding.baseUrl,
		userId: input.binding.userId,
		sourceId: savedPackage.sourceId,
	})
	const resolvedBinding: PackageServiceBindingState = {
		...input.binding,
		kodyId: savedPackage.kodyId,
		sourceId: savedPackage.sourceId,
	}
	const serviceDefinition =
		packageSource.manifest.kody.services?.[input.binding.serviceName]
	const serviceEntry = getPackageServiceEntryPath({
		manifest: packageSource.manifest,
		serviceName: input.binding.serviceName,
	})
	if (!serviceEntry) {
		throw new Error(
			`Saved package "${packageSource.manifest.kody.id}" does not define service "${input.binding.serviceName}".`,
		)
	}
	return {
		resolvedBinding,
		savedPackage,
		packageSource,
		serviceDefinition,
		serviceEntry,
	}
}

function isPackageServiceCallerLookupError(error: unknown) {
	if (!(error instanceof Error)) return false
	return (
		error.message ===
			'Saved package was not found for package service operations.' ||
		// [\s\S] so service/package ids with embedded newlines still match;
		// otherwise fetch() would rethrow and Sentry DO instrumentation would
		// treat a caller mistake as an unhandled platform failure.
		/^Saved package "[\s\S]+" does not define service "[\s\S]+"\.$/.test(
			error.message,
		)
	)
}

async function readPackageServiceRpcResponse<T>(
	response: Response,
): Promise<T> {
	const text = await response.text()
	if (!response.ok) {
		throw new Error(
			text || `Package service request failed with status ${response.status}.`,
		)
	}
	try {
		return JSON.parse(text) as T
	} catch {
		throw new Error('Package service returned an invalid JSON response.')
	}
}

/**
 * Auto-start retry delay: the 5-second base doubles per consecutive failure up
 * to a 15-minute cap, with equal jitter (a retry lands between half and the
 * full nominal delay) so crash-looping services do not retry in lockstep. A
 * successful run resets the failure count back to the base delay.
 */
export function computePackageServiceRetryDelayMs(input: {
	consecutiveFailureCount: number
	random?: () => number
}) {
	if (input.consecutiveFailureCount <= 0) {
		return packageServiceRetryDelayMs
	}
	const cappedExponent = Math.min(input.consecutiveFailureCount - 1, 16)
	const nominalDelayMs = Math.min(
		packageServiceRetryDelayMs * 2 ** cappedExponent,
		packageServiceRetryMaxDelayMs,
	)
	const random = input.random ?? Math.random
	return Math.round(nominalDelayMs / 2 + random() * (nominalDelayMs / 2))
}

function buildPackageServiceRetryTime(consecutiveFailureCount: number) {
	return new Date(
		Date.now() + computePackageServiceRetryDelayMs({ consecutiveFailureCount }),
	)
}

class PackageServiceInstanceBase extends DurableObject<Env> {
	private stateSnapshot: PackageServiceState =
		createInitialPackageServiceState()
	private activeRunPromise: Promise<void> | null = null
	private pendingStartProjection: {
		runId: string
		promise: Promise<void>
	} | null = null
	/** Per-instance shadow write chain so waitUntil hops cannot reorder. */
	private shadowQueue: Promise<void> = Promise.resolve()

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		this.ctx.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	private async restoreState() {
		const stored = await this.ctx.storage.get<PackageServiceState>(
			serviceStateStorageKey,
		)
		if (!stored) return
		this.stateSnapshot = {
			...createInitialPackageServiceState(),
			...stored,
		}
		if (
			this.stateSnapshot.currentRunId &&
			(this.stateSnapshot.status === 'running' ||
				this.stateSnapshot.status === 'stopping')
		) {
			// Background execution does not survive Durable Object eviction, so a
			// restored in-flight run must be downgraded to a recoverable stopped
			// state.
			const wasExplicitlyStopping = this.stateSnapshot.status === 'stopping'
			const orphanedRunBinding = this.stateSnapshot.binding
			const orphanedRunStartedAt = this.stateSnapshot.lastStartedAt
			this.stateSnapshot.currentRunId = null
			this.stateSnapshot.stopRequested = wasExplicitlyStopping
			this.stateSnapshot.status = 'stopped'
			this.stateSnapshot.lastStoppedAt = new Date().toISOString()
			await this.persistState()
			await this.projectServiceStateToD1()
			// The eviction interrupted the run at an unknown time, so meter the run
			// itself (it happened, and was not a user-code failure) without a
			// duration instead of never metering it or approximating one.
			const orphanedRunUsageEvent =
				orphanedRunBinding === null
					? null
					: buildServiceRuntimeUsageEvent({
							binding: orphanedRunBinding,
							startedAt: orphanedRunStartedAt,
							finishedAtMs: null,
							failed: false,
						})
			if (orphanedRunUsageEvent) {
				this.ctx.waitUntil(recordUsage(this.env, orphanedRunUsageEvent))
			}
			if (
				this.stateSnapshot.autoStart &&
				!this.stateSnapshot.stopRequested &&
				this.stateSnapshot.binding
			) {
				await this.scheduleAlarm({
					runAt: buildPackageServiceRetryTime(
						this.stateSnapshot.consecutiveFailureCount,
					),
					source: 'auto-start',
				})
			}
		} else if (this.stateSnapshot.binding) {
			// Warm-start after upgrades that introduced package_service_states:
			// project on construction (and therefore on the first post-upgrade
			// alarm wake) so inventory converges without waiting for a lifecycle
			// transition.
			await this.projectServiceStateToD1()
		}
	}

	private async persistState() {
		await this.ctx.storage.put(serviceStateStorageKey, this.stateSnapshot)
	}

	/**
	 * Best-effort D1 projection of service liveness for entitlement counting,
	 * plus the authoritative UserMeter projection. New running transitions
	 * require UserMeter confirmation; non-increasing transitions use a
	 * non-awaited shadow via `waitUntil`. D1 remains the discovery mirror.
	 * Stop/error/idle writes still attempt to clear `running` so quota is
	 * released when D1 is healthy.
	 */
	private async projectServiceStateToD1(options?: {
		requireUserMeter?: boolean
	}) {
		const binding = this.stateSnapshot.binding
		if (!binding) return
		const status = projectPackageServiceStatus(this.stateSnapshot.status)
		const startedAt = this.stateSnapshot.lastStartedAt
		const updatedAt = new Date().toISOString()
		try {
			await upsertPackageServiceState({
				db: this.env.APP_DB,
				userId: binding.userId,
				packageId: binding.packageId,
				serviceName: binding.serviceName,
				status,
				startedAt,
				updatedAt,
			})
		} catch {
			// Best-effort: D1 outages must not take down package services.
		}
		const shadowInput = {
			binding,
			status,
			mode: this.stateSnapshot.mode,
			startedAt,
			sourceUpdatedAt: updatedAt,
		}
		if (options?.requireUserMeter) {
			await this.requirePackageServiceStateInUserMeter(shadowInput)
		} else {
			this.schedulePackageServiceStateShadow(shadowInput)
		}
	}

	/**
	 * Schedule a best-effort UserMeter shadow upsert. Never awaited by
	 * lifecycle/heartbeat paths; the helper catches so `waitUntil` cannot
	 * reject. Appended to the per-instance shadow queue so rapid transitions
	 * and purge (stopped upsert then delete) cannot reorder.
	 */
	private schedulePackageServiceStateShadow(input: {
		binding: PackageServiceBindingState
		status: PackageServiceProjectedStatus
		mode: PackageServiceState['mode']
		startedAt: string | null
		sourceUpdatedAt: string
	}) {
		if (!userMeterNamespace(this.env)) return
		this.enqueueShadowTask(() =>
			this.shadowPackageServiceStateToUserMeter(input),
		)
	}

	/**
	 * Confirm a usage-increasing transition in the authoritative UserMeter
	 * before service code can run. Immediate retries cover transient RPC
	 * failures without adding delay to the serialized Durable Object request.
	 */
	private async requirePackageServiceStateInUserMeter(input: {
		binding: PackageServiceBindingState
		status: PackageServiceProjectedStatus
		mode: PackageServiceState['mode']
		startedAt: string | null
		sourceUpdatedAt: string
	}) {
		await this.enqueueShadowTask(
			async () => {
				let lastError: unknown
				for (
					let attempt = 0;
					attempt < requiredPackageServiceProjectionAttempts;
					attempt++
				) {
					try {
						const result =
							await this.upsertPackageServiceStateInUserMeter(input)
						if (result.state.status === 'running') return
						lastError = new Error(
							'UserMeter returned a non-running package service state.',
						)
					} catch (error) {
						lastError = error
					}
				}
				throw new Error(
					'Package service could not confirm running state in UserMeter.',
					{ cause: lastError },
				)
			},
			{ waitUntil: false },
		)
	}

	/** Best-effort UserMeter shadow upsert; catches/logs so waitUntil settles. */
	private async shadowPackageServiceStateToUserMeter(input: {
		binding: PackageServiceBindingState
		status: PackageServiceProjectedStatus
		mode: PackageServiceState['mode']
		startedAt: string | null
		sourceUpdatedAt: string
	}) {
		try {
			await this.upsertPackageServiceStateInUserMeter(input)
		} catch (error) {
			console.warn('package-service-user-meter-shadow-failed', error)
		}
	}

	private async upsertPackageServiceStateInUserMeter(input: {
		binding: PackageServiceBindingState
		status: PackageServiceProjectedStatus
		mode: PackageServiceState['mode']
		startedAt: string | null
		sourceUpdatedAt: string
	}) {
		const meter = userMeterRpc({
			env: this.env,
			userId: input.binding.userId,
		})
		return await meter.upsertPackageServiceState({
			packageId: input.binding.packageId,
			serviceName: input.binding.serviceName,
			status: input.status,
			mode: input.mode,
			startedAt: input.startedAt,
			sourceUpdatedAt: input.sourceUpdatedAt,
		})
	}

	/**
	 * Schedule a best-effort UserMeter shadow delete. Never awaited by purge;
	 * the helper catches so `waitUntil` cannot reject. Queued after any prior
	 * shadow upserts for this instance.
	 */
	private schedulePackageServiceShadowDelete(
		binding: PackageServiceBindingState,
	) {
		if (!userMeterNamespace(this.env)) return
		this.enqueueShadowTask(() => this.deletePackageServiceShadow(binding))
	}

	/**
	 * Run UserMeter writes in scheduling order. Best-effort callers register
	 * their caught task with `waitUntil`; required callers await rejection.
	 */
	private enqueueShadowTask(
		task: () => Promise<void>,
		options: { waitUntil: boolean } = { waitUntil: true },
	) {
		this.shadowQueue = this.shadowQueue.then(task, task)
		if (options.waitUntil) {
			this.ctx.waitUntil(this.shadowQueue)
		}
		return this.shadowQueue
	}

	/** Best-effort UserMeter shadow delete; catches/logs so waitUntil settles. */
	private async deletePackageServiceShadow(
		binding: PackageServiceBindingState,
	) {
		try {
			const meter = userMeterRpc({
				env: this.env,
				userId: binding.userId,
			})
			await meter.deletePackageServiceState({
				packageId: binding.packageId,
				serviceName: binding.serviceName,
			})
		} catch (error) {
			console.warn('package-service-user-meter-shadow-failed', error)
		}
	}

	private async deleteProjectedServiceState(
		binding: PackageServiceBindingState,
	) {
		try {
			await deletePackageServiceState({
				db: this.env.APP_DB,
				userId: binding.userId,
				packageId: binding.packageId,
				serviceName: binding.serviceName,
			})
		} catch {
			// Best-effort cleanup on purge.
		}
		this.schedulePackageServiceShadowDelete(binding)
	}

	private async ensureRunningHeartbeat() {
		if (!this.stateSnapshot.currentRunId) return
		if (this.stateSnapshot.nextAlarmAt) {
			const nextAtMs = Date.parse(this.stateSnapshot.nextAlarmAt)
			if (
				!Number.isNaN(nextAtMs) &&
				nextAtMs - Date.now() <= packageServiceStateHeartbeatMs
			) {
				return
			}
		}
		await this.scheduleAlarm({
			runAt: new Date(Date.now() + packageServiceStateHeartbeatMs),
			source: 'heartbeat',
		})
	}

	private async initializeBinding(
		binding: PackageServiceBindingState,
		options?: { armAutoStart?: boolean },
	) {
		const existing = this.stateSnapshot.binding
		if (
			existing &&
			(existing.userId !== binding.userId ||
				existing.packageId !== binding.packageId ||
				existing.serviceName !== binding.serviceName)
		) {
			throw new Error('Package service instance binding mismatch.')
		}
		const loaded = await loadSavedPackageService({
			env: this.env,
			binding,
		})
		this.stateSnapshot.binding = loaded.resolvedBinding
		this.stateSnapshot.autoStart = loaded.serviceDefinition?.autoStart ?? false
		this.stateSnapshot.mode = loaded.serviceDefinition?.mode ?? 'bounded'
		this.stateSnapshot.timeoutMs = loaded.serviceDefinition?.timeoutMs ?? null
		await this.persistState()
		if (
			options?.armAutoStart &&
			!existing &&
			this.stateSnapshot.autoStart &&
			!this.stateSnapshot.nextAlarmAt
		) {
			await this.scheduleAlarm({
				runAt: new Date(),
				source: 'auto-start',
			})
		}
		return loaded
	}

	private async scheduleAlarm(input: {
		runAt: Date | string
		source?: 'service' | 'auto-start' | 'heartbeat'
	}) {
		const runAtDate =
			typeof input.runAt === 'string' ? new Date(input.runAt) : input.runAt
		if (Number.isNaN(runAtDate.getTime())) {
			throw new Error('Invalid runAt value provided to setAlarm.')
		}
		const scheduledAt = runAtDate.toISOString()
		await this.ctx.storage.setAlarm(runAtDate)
		this.stateSnapshot.nextAlarmAt = scheduledAt
		this.stateSnapshot.nextAlarmSource = input.source ?? 'service'
		await this.persistState()
		return {
			ok: true,
			scheduled_at: scheduledAt,
		}
	}

	private async clearAlarm() {
		// Let deleteAlarm failures propagate: clearing the in-memory snapshot
		// while a platform alarm is still scheduled would cause stale runs.
		await this.ctx.storage.deleteAlarm()
		this.stateSnapshot.nextAlarmAt = null
		this.stateSnapshot.nextAlarmSource = null
		await this.persistState()
		return {
			ok: true,
		}
	}

	private buildServiceStatusResponse(
		binding: PackageServiceBindingState,
		overrides?: {
			autoStart?: boolean
			mode?: 'bounded' | 'persistent'
			timeoutMs?: number | null
		},
	) {
		const autoStart =
			overrides && 'autoStart' in overrides
				? overrides.autoStart
				: this.stateSnapshot.autoStart
		const mode =
			overrides && 'mode' in overrides
				? overrides.mode
				: this.stateSnapshot.mode
		const timeoutMs =
			overrides && 'timeoutMs' in overrides
				? overrides.timeoutMs
				: this.stateSnapshot.timeoutMs
		return {
			package_id: binding.packageId,
			kody_id: binding.kodyId,
			service_name: binding.serviceName,
			status: this.stateSnapshot.status,
			auto_start: autoStart,
			mode,
			timeout_ms: timeoutMs,
			stop_requested: this.stateSnapshot.stopRequested,
			active_run_id: this.stateSnapshot.currentRunId,
			next_alarm_at: this.stateSnapshot.nextAlarmAt,
			last_error: this.stateSnapshot.lastError,
			last_started_at: this.stateSnapshot.lastStartedAt,
			last_stopped_at: this.stateSnapshot.lastStoppedAt,
			last_run_finished_at: this.stateSnapshot.lastRunFinishedAt,
			last_result: this.stateSnapshot.lastResult,
		}
	}

	private async finalizeServiceRun(input: {
		runId: string
		nextStatus: PackageServiceState['status']
		lastResult?: unknown
		lastError?: string | null
	}) {
		if (this.stateSnapshot.currentRunId !== input.runId) return
		const binding = this.stateSnapshot.binding
		const startedAt = this.stateSnapshot.lastStartedAt
		const finishedAtMs = Date.now()
		const stopRequested = this.stateSnapshot.stopRequested
		this.stateSnapshot.status = input.nextStatus
		this.stateSnapshot.currentRunId = null
		this.stateSnapshot.stopRequested = false
		if ('lastResult' in input) {
			this.stateSnapshot.lastResult = input.lastResult ?? null
		}
		if ('lastError' in input) {
			this.stateSnapshot.lastError = input.lastError ?? null
		}
		this.stateSnapshot.consecutiveFailureCount =
			input.lastError == null
				? 0
				: this.stateSnapshot.consecutiveFailureCount + 1
		this.stateSnapshot.lastRunFinishedAt = new Date(finishedAtMs).toISOString()
		this.stateSnapshot.lastStoppedAt = this.stateSnapshot.lastRunFinishedAt
		await this.persistState()
		await this.projectServiceStateToD1()
		if (stopRequested) {
			await this.clearAlarm()
		} else if (
			this.stateSnapshot.autoStart &&
			(this.stateSnapshot.mode !== 'persistent' ||
				input.nextStatus === 'error') &&
			(!this.stateSnapshot.nextAlarmAt ||
				this.stateSnapshot.nextAlarmSource === 'heartbeat')
		) {
			await this.scheduleAlarm({
				runAt: buildPackageServiceRetryTime(
					this.stateSnapshot.consecutiveFailureCount,
				),
				source: 'auto-start',
			})
		}
		const usageEvent =
			binding === null
				? null
				: buildServiceRuntimeUsageEvent({
						binding,
						startedAt,
						finishedAtMs,
						// A run that threw counts as an error even when a concurrent stop
						// request downgrades its terminal status to 'stopped'.
						failed: input.lastError != null,
					})
		if (usageEvent) {
			this.ctx.waitUntil(recordUsage(this.env, usageEvent))
		}
	}

	private async runServiceInBackground(input: {
		binding: PackageServiceBindingState
		runId: string
		loaded?: Awaited<ReturnType<typeof loadSavedPackageService>>
	}) {
		try {
			const loaded =
				input.loaded ??
				(await loadSavedPackageService({
					env: this.env,
					binding: input.binding,
				}))
			const storageId = buildPackageServiceStorageId(
				input.binding.packageId,
				input.binding.serviceName,
			)
			this.stateSnapshot.binding = loaded.resolvedBinding
			this.stateSnapshot.autoStart =
				loaded.serviceDefinition?.autoStart ?? false
			this.stateSnapshot.mode = loaded.serviceDefinition?.mode ?? 'bounded'
			this.stateSnapshot.timeoutMs = loaded.serviceDefinition?.timeoutMs ?? null
			await this.persistState()
			const result = await this.runService(loaded.resolvedBinding, {
				getStatus: async () =>
					this.buildServiceStatusResponse(loaded.resolvedBinding, {
						autoStart: loaded.serviceDefinition?.autoStart ?? false,
						mode: loaded.serviceDefinition?.mode ?? 'bounded',
						timeoutMs: loaded.serviceDefinition?.timeoutMs ?? null,
					}),
				shouldStop: async () => this.stateSnapshot.stopRequested,
				setAlarm: async (runAt) =>
					(await this.scheduleAlarm({
						runAt,
						source: 'service',
					})) as { ok: true; scheduled_at: string },
				clearAlarm: async () => (await this.clearAlarm()) as { ok: true },
				packageContext: {
					packageId: loaded.savedPackage.id,
					kodyId: loaded.savedPackage.kodyId,
					sourceId: loaded.savedPackage.sourceId,
				},
				loaded,
				executorTimeoutMs:
					loaded.serviceDefinition?.mode === 'persistent'
						? null
						: (loaded.serviceDefinition?.timeoutMs ?? 300_000),
				storageId,
			})
			await this.finalizeServiceRun({
				runId: input.runId,
				nextStatus: 'stopped',
				lastResult: result,
			})
		} catch (error) {
			const errorMessage = getErrorMessage(error)
			await this.finalizeServiceRun({
				runId: input.runId,
				nextStatus: this.stateSnapshot.stopRequested ? 'stopped' : 'error',
				lastError: errorMessage,
			})
		} finally {
			if (this.activeRunPromise) {
				this.activeRunPromise = null
			}
		}
	}

	private async runService(
		binding: PackageServiceBindingState,
		runtime: {
			getStatus: () => Promise<
				ReturnType<PackageServiceInstanceBase['buildServiceStatusResponse']>
			>
			shouldStop: () => Promise<boolean>
			setAlarm: (
				runAt: Date | string,
			) => Promise<{ ok: true; scheduled_at: string }>
			clearAlarm: () => Promise<{ ok: true }>
			packageContext: {
				packageId: string
				kodyId: string
				sourceId: string
			}
			loaded: Awaited<ReturnType<typeof loadSavedPackageService>>
			executorTimeoutMs: number | null
			storageId: string
		},
	) {
		const [
			{ runBundledModuleWithRegistry },
			{ buildKodyModuleBundle },
			{ loadPublishedBundleArtifactByIdentity },
			{ createPackageEventTools, createPackageRuntimeInvokeTools },
		] = await Promise.all([
			import('#mcp/run-kody-registry.ts'),
			import('./module-graph.ts'),
			import('./published-bundle-artifacts.ts'),
			// Avoid a top-level package-service -> package-invocations cycle during
			// capability registry initialization.
			import('#worker/package-invocations/service.ts'),
		])
		const artifact = await loadPublishedBundleArtifactByIdentity({
			env: this.env,
			userId: binding.userId,
			sourceId: binding.sourceId,
			kind: 'service',
			artifactName: binding.serviceName,
			entryPoint: runtime.loaded.serviceEntry,
		})
		const bundle =
			artifact?.artifact ??
			(await (async () => {
				assertPublishedSourceCanRebuildWithoutInstallingDeps({
					sourceFiles: runtime.loaded.packageSource.files,
					bundleLabel: `Saved package service "${binding.serviceName}"`,
				})
				return await buildKodyModuleBundle({
					env: this.env,
					baseUrl: binding.baseUrl,
					userId: binding.userId,
					sourceFiles: runtime.loaded.packageSource.files,
					entryPoint: runtime.loaded.serviceEntry,
					rootPackageId: runtime.packageContext.packageId,
				})
			})())
		const callerContext = createMcpCallerContext({
			baseUrl: binding.baseUrl,
			executionOrigin: 'background',
			user: {
				userId: binding.userId,
				email: '',
				username: undefined,
				displayName: `package:${binding.packageId}`,
			},
			storageContext: {
				sessionId: null,
				appId: binding.packageId,
				packageId: binding.packageId,
				storageId: runtime.storageId,
			},
		})
		const runRecord = {
			packageId: binding.packageId,
			kodyId: binding.kodyId,
			sourceId: binding.sourceId,
			publishedCommit:
				runtime.loaded.packageSource.source.published_commit ?? null,
			surface: 'service' as const,
			name: binding.serviceName,
			storageId: runtime.storageId,
			metadata: {
				mode: runtime.loaded.serviceDefinition?.mode ?? 'bounded',
			},
		}
		const packageRuntimeToolsInput = {
			env: this.env,
			baseUrl: binding.baseUrl,
			callerContext,
			packageContext: runtime.packageContext,
			parentRunRecord: runRecord,
			packageInvokeDepth: 0,
		}
		const result = await runBundledModuleWithRegistry(
			this.env,
			callerContext,
			{
				mainModule: bundle.mainModule,
				modules: bundle.modules,
				dependencies: bundle.dependencies,
			},
			undefined,
			{
				packageContext: runtime.packageContext,
				serviceContext: {
					serviceName: binding.serviceName,
				},
				serviceTools: {
					getStatus: runtime.getStatus,
					shouldStop: runtime.shouldStop,
					setAlarm: runtime.setAlarm,
					clearAlarm: runtime.clearAlarm,
				},
				storageTools: {
					userId: binding.userId,
					storageId: runtime.storageId,
					writable: true,
				},
				runRecord,
				packageInvokeTools: createPackageRuntimeInvokeTools(
					packageRuntimeToolsInput,
				),
				packageEventTools: createPackageEventTools(packageRuntimeToolsInput),
				executorTimeoutMs: runtime.executorTimeoutMs,
			},
		)
		if (result.error) {
			const rawError: unknown = result.error
			const errorMessage =
				typeof rawError === 'string'
					? rawError
					: typeof rawError === 'object' &&
						  rawError !== null &&
						  'message' in rawError &&
						  typeof rawError.message === 'string'
						? rawError.message
						: String(rawError)
			throw new Error(errorMessage)
		}
		return result.result ?? null
	}

	private async failPendingStart(runId: string, error: unknown) {
		if (this.stateSnapshot.currentRunId !== runId) return
		this.stateSnapshot.currentRunId = null
		this.stateSnapshot.stopRequested = false
		this.stateSnapshot.status = 'error'
		this.stateSnapshot.lastError = getErrorMessage(error)
		this.stateSnapshot.lastStoppedAt = new Date().toISOString()
		await this.persistState()
		await this.projectServiceStateToD1()
	}

	private getOrCreateRequiredStartProjection(runId: string) {
		const existing = this.pendingStartProjection
		if (existing?.runId === runId) return existing
		const promise = Promise.resolve().then(async () => {
			try {
				await this.projectServiceStateToD1({ requireUserMeter: true })
			} catch (error) {
				await this.failPendingStart(runId, error)
				throw error
			}
		})
		const pending = { runId, promise }
		this.pendingStartProjection = pending
		return pending
	}

	private assertPendingStartIsCurrent(runId: string) {
		if (
			this.stateSnapshot.currentRunId !== runId ||
			this.stateSnapshot.status !== 'running' ||
			this.stateSnapshot.stopRequested
		) {
			throw new Error('Package service start was canceled.')
		}
	}

	private async handleStartRequest(input: {
		binding: PackageServiceBindingState
	}) {
		const pendingAtEntry = this.pendingStartProjection
		if (
			pendingAtEntry &&
			this.stateSnapshot.currentRunId === pendingAtEntry.runId
		) {
			const runId = pendingAtEntry.runId
			await pendingAtEntry.promise
			this.assertPendingStartIsCurrent(runId)
			await this.ensureRunningHeartbeat()
			this.assertPendingStartIsCurrent(runId)
			return Response.json({
				ok: true,
				run_id: runId,
				started_at:
					this.stateSnapshot.lastStartedAt ?? new Date().toISOString(),
				status: 'running',
				already_running: true,
			} satisfies PackageServiceRunResult)
		}
		const loaded = await this.initializeBinding(input.binding, {
			armAutoStart: true,
		})
		if (this.stateSnapshot.currentRunId) {
			const runId = this.stateSnapshot.currentRunId
			const pending = this.pendingStartProjection
			if (pending?.runId === runId) {
				await pending.promise
			}
			this.assertPendingStartIsCurrent(runId)
			await this.ensureRunningHeartbeat()
			this.assertPendingStartIsCurrent(runId)
			return Response.json({
				ok: true,
				run_id: runId,
				started_at:
					this.stateSnapshot.lastStartedAt ?? new Date().toISOString(),
				status: 'running',
				already_running: true,
			} satisfies PackageServiceRunResult)
		}
		const startedAt = new Date().toISOString()
		const runId = crypto.randomUUID()
		this.stateSnapshot.stopRequested = false
		this.stateSnapshot.currentRunId = runId
		this.stateSnapshot.status = 'running'
		this.stateSnapshot.lastStartedAt = startedAt
		this.stateSnapshot.lastError = null
		await this.persistState()
		const pending = this.getOrCreateRequiredStartProjection(runId)
		try {
			await pending.promise
			this.assertPendingStartIsCurrent(runId)
			await this.ensureRunningHeartbeat()
			this.assertPendingStartIsCurrent(runId)
		} catch (error) {
			await this.failPendingStart(runId, error)
			if (this.pendingStartProjection === pending) {
				this.pendingStartProjection = null
			}
			throw error
		}
		if (this.pendingStartProjection === pending) {
			this.pendingStartProjection = null
		}
		const task = this.runServiceInBackground({
			binding: loaded.resolvedBinding,
			runId,
			loaded,
		})
		this.activeRunPromise = task
		this.ctx.waitUntil(task)
		return Response.json({
			ok: true,
			run_id: runId,
			started_at: startedAt,
			status: 'running',
		} satisfies PackageServiceRunResult)
	}

	private async handleStatusRequest(input: {
		binding: PackageServiceBindingState
	}) {
		let loaded: Awaited<ReturnType<typeof loadSavedPackageService>> | undefined
		try {
			loaded = await loadSavedPackageService({
				env: this.env,
				binding: input.binding,
			})
		} catch {
			loaded = undefined
		}
		const binding =
			loaded?.resolvedBinding ?? this.stateSnapshot.binding ?? input.binding
		return Response.json(
			this.buildServiceStatusResponse(binding, {
				autoStart:
					loaded?.serviceDefinition?.autoStart ?? this.stateSnapshot.autoStart,
				mode: loaded?.serviceDefinition?.mode ?? this.stateSnapshot.mode,
				timeoutMs:
					loaded?.serviceDefinition?.timeoutMs ?? this.stateSnapshot.timeoutMs,
			}),
		)
	}

	private async handleStopRequest(input: {
		binding: PackageServiceBindingState
	}) {
		const runId = this.stateSnapshot.currentRunId
		if (runId) {
			if (
				this.pendingStartProjection?.runId === runId &&
				this.activeRunPromise === null
			) {
				this.stateSnapshot.currentRunId = null
				this.stateSnapshot.stopRequested = false
				this.stateSnapshot.status = 'stopped'
			} else {
				this.stateSnapshot.stopRequested = true
				this.stateSnapshot.status = 'stopping'
			}
			this.stateSnapshot.lastStoppedAt = new Date().toISOString()
		} else {
			this.stateSnapshot.stopRequested = false
			this.stateSnapshot.status = 'stopped'
		}
		try {
			await this.initializeBinding(input.binding)
		} catch {
			// Allow an in-flight service to be stopped even if its package/source was removed.
			this.stateSnapshot.binding ??= input.binding
		}
		await this.clearAlarm()
		await this.projectServiceStateToD1()
		return Response.json({
			ok: true,
		})
	}

	private async handlePurgeRequest(input: {
		binding: PackageServiceBindingState
	}) {
		try {
			await this.handleStopRequest(input)
		} catch {
			// Continue with hard deletion even if package/source lookup fails.
		}
		const binding = this.stateSnapshot.binding ?? input.binding
		this.stateSnapshot = createInitialPackageServiceState()
		this.activeRunPromise = null
		this.pendingStartProjection = null
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort cleanup before deleteAll.
		})
		// Clear D1 + UserMeter shadow before deleteAll.
		await this.deleteProjectedServiceState(binding)
		await this.ctx.storage.deleteAll()
		return Response.json({
			ok: true,
		})
	}

	async fetch(request: Request) {
		const url = new URL(request.url)
		const body = (await request.json().catch(() => null)) as {
			binding?: PackageServiceBindingState
		} | null
		const binding = body?.binding
		if (!binding) {
			return new Response('Missing package service binding.', { status: 400 })
		}
		try {
			if (request.method === 'POST' && url.pathname.endsWith('/start')) {
				return await this.handleStartRequest({ binding })
			}
			if (request.method === 'POST' && url.pathname.endsWith('/status')) {
				return await this.handleStatusRequest({ binding })
			}
			if (request.method === 'POST' && url.pathname.endsWith('/stop')) {
				return await this.handleStopRequest({ binding })
			}
			if (request.method === 'POST' && url.pathname.endsWith('/purge')) {
				return await this.handlePurgeRequest({ binding })
			}
			return new Response('Not found', { status: 404 })
		} catch (error) {
			// Caller mistakes (undeclared service name, deleted package) must
			// return an error Response. Throwing here is reported by the DO
			// Sentry instrumentation as an unhandled platform failure.
			if (isPackageServiceCallerLookupError(error)) {
				return new Response(
					error instanceof Error
						? error.message
						: 'Package service request failed.',
					{ status: 404 },
				)
			}
			throw error
		}
	}

	async alarm() {
		const binding = this.stateSnapshot.binding
		if (!binding) return
		const alarmSource = this.stateSnapshot.nextAlarmSource ?? 'service'
		let capturedRunId: string | null = null
		this.stateSnapshot.nextAlarmAt = null
		this.stateSnapshot.nextAlarmSource = null
		await this.persistState()
		if (this.stateSnapshot.currentRunId) {
			await this.projectServiceStateToD1()
			await this.ensureRunningHeartbeat()
			return
		}
		if (alarmSource === 'heartbeat') {
			return
		}
		try {
			const loaded = await loadSavedPackageService({
				env: this.env,
				binding,
			})
			this.stateSnapshot.binding = loaded.resolvedBinding
			this.stateSnapshot.autoStart =
				loaded.serviceDefinition?.autoStart ?? false
			this.stateSnapshot.mode = loaded.serviceDefinition?.mode ?? 'bounded'
			this.stateSnapshot.timeoutMs = loaded.serviceDefinition?.timeoutMs ?? null
			await this.persistState()
			if (
				!this.stateSnapshot.stopRequested &&
				(alarmSource === 'service' || this.stateSnapshot.autoStart)
			) {
				const startedAt = new Date().toISOString()
				const runId = crypto.randomUUID()
				capturedRunId = runId
				this.stateSnapshot.currentRunId = runId
				this.stateSnapshot.status = 'running'
				this.stateSnapshot.lastStartedAt = startedAt
				this.stateSnapshot.lastError = null
				await this.persistState()
				const pending = this.getOrCreateRequiredStartProjection(runId)
				await pending.promise
				this.assertPendingStartIsCurrent(runId)
				await this.ensureRunningHeartbeat()
				this.assertPendingStartIsCurrent(runId)
				if (this.pendingStartProjection === pending) {
					this.pendingStartProjection = null
				}
				const task = this.runServiceInBackground({
					binding: loaded.resolvedBinding,
					runId,
					loaded,
				})
				this.activeRunPromise = task
				this.ctx.waitUntil(task)
			}
		} catch (error) {
			if (
				capturedRunId &&
				this.pendingStartProjection?.runId === capturedRunId
			) {
				this.pendingStartProjection = null
			}
			if (
				capturedRunId &&
				this.stateSnapshot.currentRunId !== capturedRunId &&
				this.stateSnapshot.status === 'stopped'
			) {
				return
			}
			this.stateSnapshot.currentRunId = null
			this.stateSnapshot.lastError = getErrorMessage(error)
			this.stateSnapshot.status = 'error'
			this.stateSnapshot.lastStoppedAt = new Date().toISOString()
			this.stateSnapshot.consecutiveFailureCount += 1
			await this.persistState()
			await this.projectServiceStateToD1()
			if (
				this.stateSnapshot.autoStart &&
				!this.stateSnapshot.stopRequested &&
				!this.stateSnapshot.nextAlarmAt
			) {
				await this.scheduleAlarm({
					runAt: buildPackageServiceRetryTime(
						this.stateSnapshot.consecutiveFailureCount,
					),
					source: alarmSource,
				})
			}
		}
	}
}

export const PackageServiceInstance = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	PackageServiceInstanceBase,
)

export function packageServiceRpc(input: {
	env: Env
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
	serviceName: string
}) {
	const binding: PackageServiceBindingState = {
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		sourceId: input.sourceId,
		baseUrl: input.baseUrl,
		serviceName: input.serviceName,
	}
	const stub = getPackageServiceStub(input)
	async function callService<T>(path: string): Promise<T> {
		const response = await stub.fetch(
			new Request(`https://package-service.invalid${path}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ binding }),
			}),
		)
		return await readPackageServiceRpcResponse<T>(response)
	}
	return {
		async start() {
			return await callService<PackageServiceRunResult>('/service/start')
		},
		async status() {
			return await callService<
				ReturnType<PackageServiceInstanceBase['buildServiceStatusResponse']>
			>('/service/status')
		},
		async stop() {
			return await callService<{ ok: true }>('/service/stop')
		},
		async purge() {
			return await callService<{ ok: true }>('/service/purge')
		},
	}
}

export async function listSavedPackageServices(input: {
	env: Env
	userId: string
	baseUrl: string
	packageId: string
	savedPackage?: {
		id: string
		sourceId: string
		kodyId?: string
	}
}) {
	const savedPackage =
		input.savedPackage ??
		(await getSavedPackageById(input.env.APP_DB, {
			userId: input.userId,
			packageId: input.packageId,
		}))
	if (!savedPackage) {
		throw new Error('Saved package was not found.')
	}
	const loaded = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: savedPackage.sourceId,
	})
	return {
		savedPackage,
		services: listPackageServices(loaded.manifest),
	}
}
