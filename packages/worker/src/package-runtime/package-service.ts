import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	getPackageServiceEntryPath,
	listPackageServices,
} from '#worker/package-registry/manifest.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'

const serviceStateStorageKey = 'package-service-state'

export type PackageServiceBindingState = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
	serviceName: string
}

type PackageServiceState = {
	binding: PackageServiceBindingState | null
	autoStart: boolean
	timeoutMs: number | null
	stopRequested: boolean
	currentRunId: string | null
	nextAlarmAt: string | null
	lastStartedAt: string | null
	lastStoppedAt: string | null
	status: 'idle' | 'running' | 'stopping' | 'stopped' | 'error'
	lastError: string | null
	lastResult: unknown
	lastRunFinishedAt: string | null
}

type PackageServiceRunResult = {
	ok: boolean
	run_id: string
	started_at: string
	status: 'running'
	already_running?: boolean
}

function createInitialPackageServiceState(): PackageServiceState {
	return {
		binding: null,
		autoStart: false,
		timeoutMs: null,
		stopRequested: false,
		currentRunId: null,
		nextAlarmAt: null,
		lastStartedAt: null,
		lastStoppedAt: null,
		status: 'idle',
		lastError: null,
		lastResult: null,
		lastRunFinishedAt: null,
	}
}

function buildPackageServiceName(input: {
	userId: string
	packageId: string
	serviceName: string
}) {
	return JSON.stringify([input.userId, input.packageId, input.serviceName])
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
		buildPackageServiceName({
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

async function loadSavedPackageService(input: {
	env: Env
	binding: PackageServiceBindingState
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.binding.userId,
		packageId: input.binding.packageId,
	})
	if (!savedPackage) {
		throw new Error('Saved package was not found for package service operations.')
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

export async function readPackageServiceRpcResponse<T>(
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

class PackageServiceInstanceBase extends DurableObject<Env> {
	private stateSnapshot: PackageServiceState = createInitialPackageServiceState()
	private activeRunPromise: Promise<void> | null = null

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		this.ctx.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	private async restoreState() {
		const stored =
			await this.ctx.storage.get<PackageServiceState>(serviceStateStorageKey)
		if (!stored) return
		this.stateSnapshot = stored
		if (
			this.stateSnapshot.currentRunId &&
			(this.stateSnapshot.status === 'running' ||
				this.stateSnapshot.status === 'stopping')
		) {
			// Background execution does not survive Durable Object eviction, so a
			// restored in-flight run must be downgraded to a recoverable stopped
			// state.
			this.stateSnapshot.currentRunId = null
			this.stateSnapshot.stopRequested = false
			this.stateSnapshot.status = 'stopped'
			this.stateSnapshot.lastStoppedAt = new Date().toISOString()
			await this.persistState()
		}
	}

	private async persistState() {
		await this.ctx.storage.put(serviceStateStorageKey, this.stateSnapshot)
	}

	private async initializeBinding(binding: PackageServiceBindingState) {
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
		this.stateSnapshot.timeoutMs = loaded.serviceDefinition?.timeoutMs ?? null
		await this.persistState()
		if (!existing && this.stateSnapshot.autoStart) {
			const nextAlarmAt = new Date().toISOString()
			await this.ctx.storage.setAlarm(new Date(nextAlarmAt))
			this.stateSnapshot.nextAlarmAt = nextAlarmAt
			await this.persistState()
		}
		return loaded
	}

	private async scheduleAlarm(input: { runAt: Date | string }) {
		const runAtDate =
			typeof input.runAt === 'string' ? new Date(input.runAt) : input.runAt
		if (Number.isNaN(runAtDate.getTime())) {
			throw new Error('Invalid runAt value provided to setAlarm.')
		}
		const scheduledAt = runAtDate.toISOString()
		await this.ctx.storage.setAlarm(runAtDate)
		this.stateSnapshot.nextAlarmAt = scheduledAt
		await this.persistState()
		return {
			ok: true,
			scheduled_at: scheduledAt,
		}
	}

	private async clearAlarm() {
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort cleanup.
		})
		this.stateSnapshot.nextAlarmAt = null
		await this.persistState()
		return {
			ok: true,
		}
	}

	private buildServiceStatusResponse(binding: PackageServiceBindingState) {
		return {
			package_id: binding.packageId,
			kody_id: binding.kodyId,
			service_name: binding.serviceName,
			status: this.stateSnapshot.status,
			auto_start: this.stateSnapshot.autoStart,
			timeout_ms: this.stateSnapshot.timeoutMs,
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

	private async runServiceInBackground(input: {
		binding: PackageServiceBindingState
		runId: string
	}) {
		try {
			const loaded = await loadSavedPackageService({
				env: this.env,
				binding: input.binding,
			})
			const storageId = buildPackageServiceStorageId(
				input.binding.packageId,
				input.binding.serviceName,
			)
			this.stateSnapshot.binding = loaded.resolvedBinding
			this.stateSnapshot.autoStart = loaded.serviceDefinition?.autoStart ?? false
			this.stateSnapshot.timeoutMs = loaded.serviceDefinition?.timeoutMs ?? null
			await this.persistState()
			const result = await this.runService(loaded.resolvedBinding, {
				getStatus: async () =>
					this.buildServiceStatusResponse(loaded.resolvedBinding),
				shouldStop: async () => this.stateSnapshot.stopRequested,
				setAlarm: async (runAt) =>
					(await this.scheduleAlarm({
						runAt,
					})) as { ok: true; scheduled_at: string },
				clearAlarm: async () =>
					(await this.clearAlarm()) as { ok: true },
				packageContext: {
					packageId: loaded.savedPackage.id,
					kodyId: loaded.savedPackage.kodyId,
				},
				loaded,
				executorTimeoutMs: loaded.serviceDefinition?.timeoutMs ?? 300_000,
				storageId,
			})
			if (this.stateSnapshot.currentRunId !== input.runId) return
			const stopRequested = this.stateSnapshot.stopRequested
			this.stateSnapshot.status = 'stopped'
			this.stateSnapshot.currentRunId = null
			this.stateSnapshot.lastResult = result
			this.stateSnapshot.lastRunFinishedAt = new Date().toISOString()
			this.stateSnapshot.lastStoppedAt = this.stateSnapshot.lastRunFinishedAt
			await this.persistState()
			if (stopRequested) {
				await this.clearAlarm()
			}
		} catch (error) {
			if (this.stateSnapshot.currentRunId !== input.runId) return
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			const stopRequested = this.stateSnapshot.stopRequested
			this.stateSnapshot.status = this.stateSnapshot.stopRequested
				? 'stopped'
				: 'error'
			this.stateSnapshot.currentRunId = null
			this.stateSnapshot.lastError = errorMessage
			this.stateSnapshot.lastRunFinishedAt = new Date().toISOString()
			this.stateSnapshot.lastStoppedAt = this.stateSnapshot.lastRunFinishedAt
			await this.persistState()
			if (stopRequested) {
				await this.clearAlarm()
			}
		} finally {
			if (this.activeRunPromise) {
				this.activeRunPromise = null
			}
		}
	}

	private async runService(
		binding: PackageServiceBindingState,
		runtime: {
			getStatus: () => Promise<ReturnType<PackageServiceInstanceBase['buildServiceStatusResponse']>>
			shouldStop: () => Promise<boolean>
			setAlarm: (runAt: Date) => Promise<{ ok: true; scheduled_at: string }>
			clearAlarm: () => Promise<{ ok: true }>
			packageContext: {
				packageId: string
				kodyId: string
			}
			loaded: Awaited<ReturnType<typeof loadSavedPackageService>>
			executorTimeoutMs: number
			storageId: string
		},
	) {
		const [{ runBundledModuleWithRegistry }, { buildKodyModuleBundle }, { loadPublishedBundleArtifactByIdentity }] =
			await Promise.all([
				import('#mcp/run-codemode-registry.ts'),
				import('./module-graph.ts'),
				import('./published-bundle-artifacts.ts'),
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
			(await buildKodyModuleBundle({
				env: this.env,
				baseUrl: binding.baseUrl,
				userId: binding.userId,
				sourceFiles: runtime.loaded.packageSource.files,
				entryPoint: runtime.loaded.serviceEntry,
			}))
		const callerContext = createMcpCallerContext({
			baseUrl: binding.baseUrl,
			user: {
				userId: binding.userId,
				email: '',
				displayName: `package:${binding.packageId}`,
			},
			storageContext: {
				sessionId: null,
				appId: binding.packageId,
				storageId: runtime.storageId,
			},
		})
		const result = await runBundledModuleWithRegistry(
			this.env,
			callerContext,
			{
				mainModule: bundle.mainModule,
				modules: bundle.modules,
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

	private async handleStartRequest(input: {
		binding: PackageServiceBindingState
	}) {
		const loaded = await this.initializeBinding(input.binding)
		if (this.stateSnapshot.currentRunId) {
			return Response.json({
				ok: true,
				run_id: this.stateSnapshot.currentRunId,
				started_at: this.stateSnapshot.lastStartedAt ?? new Date().toISOString(),
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
		const task = this.runServiceInBackground({
			binding: loaded.resolvedBinding,
			runId,
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
		const loaded = await this.initializeBinding(input.binding)
		return Response.json(this.buildServiceStatusResponse(loaded.resolvedBinding))
	}

	private async handleStopRequest(input: {
		binding: PackageServiceBindingState
	}) {
		await this.initializeBinding(input.binding)
		if (this.stateSnapshot.currentRunId) {
			this.stateSnapshot.stopRequested = true
			this.stateSnapshot.status = 'stopping'
			this.stateSnapshot.lastStoppedAt = new Date().toISOString()
		} else {
			this.stateSnapshot.stopRequested = false
			this.stateSnapshot.status = 'stopped'
		}
		await this.clearAlarm()
		return Response.json({
			ok: true,
		})
	}

	async fetch(request: Request) {
		const url = new URL(request.url)
		const body = (await request.json().catch(() => null)) as
			| { binding?: PackageServiceBindingState }
			| null
		const binding = body?.binding
		if (!binding) {
			return new Response('Missing package service binding.', { status: 400 })
		}
		if (request.method === 'POST' && url.pathname.endsWith('/start')) {
			return await this.handleStartRequest({ binding })
		}
		if (request.method === 'POST' && url.pathname.endsWith('/status')) {
			return await this.handleStatusRequest({ binding })
		}
		if (request.method === 'POST' && url.pathname.endsWith('/stop')) {
			return await this.handleStopRequest({ binding })
		}
		return new Response('Not found', { status: 404 })
	}

	async alarm() {
		const binding = this.stateSnapshot.binding
		if (!binding) return
		this.stateSnapshot.nextAlarmAt = null
		await this.persistState()
		if (this.stateSnapshot.currentRunId) return
		try {
			const loaded = await loadSavedPackageService({
				env: this.env,
				binding,
			})
			this.stateSnapshot.binding = loaded.resolvedBinding
			this.stateSnapshot.autoStart = loaded.serviceDefinition?.autoStart ?? false
			this.stateSnapshot.timeoutMs =
				loaded.serviceDefinition?.timeoutMs ?? null
			await this.persistState()
			if (!this.stateSnapshot.stopRequested) {
				await this.handleStartRequest({ binding: loaded.resolvedBinding })
			}
		} catch (error) {
			this.stateSnapshot.lastError =
				error instanceof Error ? error.message : String(error)
			this.stateSnapshot.status = 'error'
			await this.persistState()
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
	}
}

export async function listSavedPackageServices(input: {
	env: Env
	userId: string
	baseUrl: string
	packageId: string
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
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
