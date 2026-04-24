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
	lastStartedAt: string | null
	lastStoppedAt: string | null
	status: 'idle' | 'running' | 'stopped' | 'error'
	lastError: string | null
	lastResult: unknown
	lastRunFinishedAt: string | null
}

type PackageServiceRunResult = {
	ok: boolean
	result?: unknown
	error?: string
	started_at: string
	finished_at: string
}

function createInitialPackageServiceState(): PackageServiceState {
	return {
		binding: null,
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
	return `service:${packageId}:${encodeURIComponent(serviceName)}`
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
		sourceId: input.binding.sourceId,
	})
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
		savedPackage,
		packageSource,
		serviceEntry,
	}
}

class PackageServiceInstanceBase extends DurableObject<Env> {
	private stateSnapshot: PackageServiceState = createInitialPackageServiceState()

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
		if (!existing) {
			this.stateSnapshot.binding = binding
			await this.persistState()
		}
	}

	private async runService(binding: PackageServiceBindingState) {
		const [{ runBundledModuleWithRegistry }, { buildKodyModuleBundle }, { loadPublishedBundleArtifactByIdentity }] =
			await Promise.all([
				import('#mcp/run-codemode-registry.ts'),
				import('./module-graph.ts'),
				import('./published-bundle-artifacts.ts'),
			])
		const loaded = await loadSavedPackageService({
			env: this.env,
			binding,
		})
		const artifact = await loadPublishedBundleArtifactByIdentity({
			env: this.env,
			userId: binding.userId,
			sourceId: binding.sourceId,
			kind: 'service',
			artifactName: binding.serviceName,
			entryPoint: loaded.serviceEntry,
		})
		const bundle =
			artifact?.artifact ??
			(await buildKodyModuleBundle({
				env: this.env,
				baseUrl: binding.baseUrl,
				userId: binding.userId,
				sourceFiles: loaded.packageSource.files,
				entryPoint: loaded.serviceEntry,
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
				storageId: buildPackageServiceStorageId(
					binding.packageId,
					binding.serviceName,
				),
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
				packageContext: {
					packageId: loaded.savedPackage.id,
					kodyId: loaded.savedPackage.kodyId,
				},
				serviceContext: {
					serviceName: binding.serviceName,
				},
				storageTools: {
					userId: binding.userId,
					storageId: buildPackageServiceStorageId(
						binding.packageId,
						binding.serviceName,
					),
					writable: true,
				},
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
		await this.initializeBinding(input.binding)
		const startedAt = new Date().toISOString()
		this.stateSnapshot.status = 'running'
		this.stateSnapshot.lastStartedAt = startedAt
		this.stateSnapshot.lastError = null
		await this.persistState()
		try {
			const result = await this.runService(input.binding)
			this.stateSnapshot.status = 'stopped'
			this.stateSnapshot.lastResult = result
			this.stateSnapshot.lastRunFinishedAt = new Date().toISOString()
			this.stateSnapshot.lastStoppedAt = this.stateSnapshot.lastRunFinishedAt
			await this.ctx.storage.deleteAlarm().catch(() => {
				// Best effort cleanup.
			})
			await this.persistState()
			return Response.json({
				ok: true,
				result,
				started_at: startedAt,
				finished_at: this.stateSnapshot.lastRunFinishedAt,
			} satisfies PackageServiceRunResult)
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			this.stateSnapshot.status = 'error'
			this.stateSnapshot.lastError = errorMessage
			this.stateSnapshot.lastRunFinishedAt = new Date().toISOString()
			this.stateSnapshot.lastStoppedAt = this.stateSnapshot.lastRunFinishedAt
			await this.persistState()
			return Response.json(
				{
					ok: false,
					error: errorMessage,
					started_at: startedAt,
					finished_at: this.stateSnapshot.lastRunFinishedAt,
				} satisfies PackageServiceRunResult,
				{ status: 500 },
			)
		}
	}

	private async handleStatusRequest(input: {
		binding: PackageServiceBindingState
	}) {
		await this.initializeBinding(input.binding)
		const serviceDefinition = this.stateSnapshot.binding
			? (await loadSavedPackageService({
					env: this.env,
					binding: input.binding,
				})).packageSource.manifest.kody.services?.[input.binding.serviceName] ?? null
			: null
		return Response.json({
			package_id: input.binding.packageId,
			kody_id: input.binding.kodyId,
			service_name: input.binding.serviceName,
			status: this.stateSnapshot.status,
			auto_start: serviceDefinition?.autoStart ?? false,
			last_error: this.stateSnapshot.lastError,
			last_started_at: this.stateSnapshot.lastStartedAt,
			last_stopped_at: this.stateSnapshot.lastStoppedAt,
			last_run_finished_at: this.stateSnapshot.lastRunFinishedAt,
			last_result: this.stateSnapshot.lastResult,
		})
	}

	private async handleStopRequest(input: {
		binding: PackageServiceBindingState
	}) {
		await this.initializeBinding(input.binding)
		this.stateSnapshot.status = 'stopped'
		this.stateSnapshot.lastStoppedAt = new Date().toISOString()
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort cleanup.
		})
		await this.persistState()
		return Response.json({ ok: true })
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
		const loaded = await loadSavedPackageService({
			env: this.env,
			binding,
		})
		if (loaded.packageSource.manifest.kody.services?.[binding.serviceName]?.autoStart) {
			await this.handleStartRequest({ binding })
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
	return {
		async start() {
			const response = await stub.fetch(
				new Request('https://package-service.invalid/service/start', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ binding }),
				}),
			)
			return await response.json()
		},
		async status() {
			const response = await stub.fetch(
				new Request('https://package-service.invalid/service/status', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ binding }),
				}),
			)
			return await response.json()
		},
		async stop() {
			const response = await stub.fetch(
				new Request('https://package-service.invalid/service/stop', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ binding }),
				}),
			)
			return await response.json()
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
