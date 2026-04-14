import * as Sentry from '@sentry/cloudflare'
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { getValue, saveValue } from '#mcp/values/service.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import {
	buildConnectorValueName,
	parseConnectorConfig,
	parseConnectorJson,
} from '#mcp/capabilities/values/connector-shared.ts'
import {
	buildFacetClassExportName,
	buildFacetName,
} from '#mcp/app-runner-facet-names.ts'
import { hasUiArtifactServerCode } from '#mcp/ui-artifacts-types.ts'

const defaultAppRateLimit = 120
const appRunnerFacetIdPrefix = 'facet'
const appBackendHeader = 'X-Kody-App-Backend'
const defaultStorageExportPageSize = 250
const maxStorageExportPageSize = 1_000

type AppRunnerConfig = {
	appId: string
	userId: string
	baseUrl: string
	facetNames: Array<string>
	serverCode: string | null
	serverCodeId: string
	rateLimitPerMinute: number
	killSwitchEnabled: boolean
	lastError: string | null
}

type AppRunnerMetrics = {
	requestCount: number
	errorCount: number
	lastRequestAt: string | null
}

type AppRunnerRateWindow = {
	windowStartedAt: number
	requestCount: number
}

type FacetBridgeProps = {
	appId: string
	userId: string
	baseUrl: string
	facetName: string
}

type FacetStorageExport = {
	entries: Array<{
		key: string
		value: unknown
	}>
	estimatedBytes: number
	truncated: boolean
	nextStartAfter: string | null
	pageSize: number
}

const configStorageKey = 'config'
const metricsStorageKey = 'metrics'
const rateWindowStorageKey = 'rate-window'

function defaultConfig(appId: string): AppRunnerConfig {
	return {
		appId,
		userId: '',
		baseUrl: '',
		facetNames: ['main'],
		serverCode: null,
		serverCodeId: crypto.randomUUID(),
		rateLimitPerMinute: defaultAppRateLimit,
		killSwitchEnabled: false,
		lastError: null,
	}
}

function defaultMetrics(): AppRunnerMetrics {
	return {
		requestCount: 0,
		errorCount: 0,
		lastRequestAt: null,
	}
}

function defaultRateWindow(now: number): AppRunnerRateWindow {
	return {
		windowStartedAt: now,
		requestCount: 0,
	}
}

function createFacetWrapperModule(input: { facetName: string }) {
	const exportName = buildFacetClassExportName(input.facetName)
	return `
import * as userModule from './user-app.js'

const BaseApp = userModule.App

if (typeof BaseApp !== 'function') {
	throw new Error('Saved app server code must export class App extends DurableObject.')
}

export class ${exportName} extends BaseApp {
	async __kody_resetStorage() {
		await this.ctx.storage.deleteAll()
		return { ok: true }
	}

	async __kody_exportStorage(options) {
		const requestedPageSize =
			typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize)
				? Math.trunc(options.pageSize)
				: ${defaultStorageExportPageSize}
		const pageSize = Math.min(
			Math.max(requestedPageSize, 1),
			${maxStorageExportPageSize},
		)
		const startAfter =
			typeof options?.startAfter === 'string' && options.startAfter
				? options.startAfter
				: undefined
		const entries = []
		let nextStartAfter = null
		let truncated = false
		const listedEntries = await this.ctx.storage.list({
			...(startAfter ? { startAfter } : {}),
			limit: pageSize + 1,
		})
		for (const [key, value] of listedEntries) {
			if (entries.length === pageSize) {
				truncated = true
				break
			}
			entries.push({ key, value })
			nextStartAfter = key
		}
		return {
			entries,
			estimatedBytes: this.ctx.storage.sql.databaseSize,
			truncated,
			nextStartAfter: truncated ? nextStartAfter : null,
			pageSize,
		}
	}
}
`.trim()
}

const savedAppExecEntrypointName = 'SavedAppExecWorker'

function createSavedAppExecWorkerModule(input: { code: string }) {
	return `
import { WorkerEntrypoint } from 'cloudflare:workers'

export class ${savedAppExecEntrypointName} extends WorkerEntrypoint {
	async run(params) {
		const app = {
			call: (methodName, ...args) => {
				return this.env.APP.callAppRpc(methodName, args)
			},
		}
		${input.code}
	}
}
`.trim()
}

function buildFacetRequestUrl(request: Request, facetName: string) {
	const nextUrl = new URL(request.url)
	nextUrl.searchParams.set('__facet', facetName)
	return nextUrl.toString()
}

async function readJson<T>(request: Request): Promise<T | null> {
	return (await request.json().catch(() => null)) as T | null
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}

export class AppFacetBridge extends WorkerEntrypoint<Env, FacetBridgeProps> {
	async callAppRpc(methodName: string, args: Array<unknown> = []) {
		const runner = appRunnerRpc(this.env, this.ctx.props.appId)
		return await runner.callFacetRpc({
			appId: this.ctx.props.appId,
			facetName: this.ctx.props.facetName,
			methodName,
			args,
		})
	}

	async fetchWithResolvedSecrets(input: {
		url: string
		method?: string
		headers?: Record<string, string>
		body?: string
	}) {
		const request = new Request(input.url, {
			method: input.method ?? 'GET',
			headers: input.headers,
			body: input.body,
		})
		const resolved = await expandSecretPlaceholders({
			request,
			props: {
				baseUrl: this.ctx.props.baseUrl,
				userId: this.ctx.props.userId,
				storageContext: {
					sessionId: null,
					appId: this.ctx.props.appId,
				},
			},
			env: this.env,
		})
		return {
			url: resolved.url,
			method: resolved.method,
			headers: Object.fromEntries(resolved.headers.entries()),
			body:
				resolved.method === 'GET' || resolved.method === 'HEAD'
					? undefined
					: await resolved.text(),
		}
	}

	async connectorGet(args: Record<string, unknown>) {
		const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
		if (!name) {
			throw new Error('connector_get requires a connector name.')
		}
		const value = await getValue({
			env: this.env,
			userId: this.ctx.props.userId,
			name: buildConnectorValueName(name),
			scope: 'user',
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.appId,
			},
		})
		if (!value) {
			return { connector: null }
		}
		return {
			connector: parseConnectorConfig(parseConnectorJson(value.value), name),
		}
	}

	async connectorList() {
		const values = await import('#mcp/values/service.ts').then(
			({ listValues }) =>
				listValues({
					env: this.env,
					userId: this.ctx.props.userId,
					scope: 'user',
					storageContext: {
						sessionId: null,
						appId: this.ctx.props.appId,
					},
				}),
		)
		const connectors = values
			.map((value) => {
				const name = value.name.startsWith('_connector:')
					? value.name.slice('_connector:'.length).trim()
					: null
				if (!name) return null
				return parseConnectorConfig(parseConnectorJson(value.value), name)
			})
			.filter((value): value is NonNullable<typeof value> => value != null)
		return { connectors }
	}

	async valueGet(name: string, scope: 'app' | 'user' = 'app') {
		return await getValue({
			env: this.env,
			userId: this.ctx.props.userId,
			name,
			scope,
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.appId,
			},
		})
	}

	async valueSet(input: {
		name: string
		value: string
		description?: string
		scope?: 'app' | 'user'
	}) {
		return await saveValue({
			env: this.env,
			userId: this.ctx.props.userId,
			name: input.name,
			value: input.value,
			description: input.description ?? '',
			scope: input.scope ?? 'app',
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.appId,
			},
		})
	}

	async secretPlaceholder(name: string, scope: 'app' | 'user' = 'app') {
		const resolved = await resolveSecret({
			env: this.env,
			userId: this.ctx.props.userId,
			name,
			scope,
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.appId,
			},
		})
		if (!resolved.found) {
			throw new Error(`Secret "${name}" was not found.`)
		}
		return `{{secret:${name}|scope=${scope}}}`
	}

	async metaRunSkill(
		name: string,
		params: Record<string, unknown> | undefined,
	) {
		const { metaRunSkillCapability } =
			await import('#mcp/capabilities/meta/meta-run-skill.ts')
		const { createMcpCallerContext } = await import('#mcp/context.ts')
		return await metaRunSkillCapability.handler(
			{ name, params },
			{
				env: this.env,
				callerContext: createMcpCallerContext({
					baseUrl: this.ctx.props.baseUrl,
					user: {
						userId: this.ctx.props.userId,
						email: '',
						displayName: `saved-app:${this.ctx.props.appId}`,
					},
					storageContext: {
						sessionId: null,
						appId: this.ctx.props.appId,
					},
				}),
			},
		)
	}
}

class AppRunnerBase extends DurableObject<Env> {
	async fetch(request: Request) {
		const url = new URL(request.url)
		const facetName = buildFacetName(url.searchParams.get('__facet'))
		const pathSegments = url.pathname.split('/').filter(Boolean)
		const action = pathSegments.at(-1) ?? ''

		if (
			request.method === 'POST' &&
			pathSegments.length >= 2 &&
			pathSegments[0] === '_kody'
		) {
			return await this.handleLifecycleAction(action, facetName, request)
		}

		try {
			await this.applyRateLimit()
			const facet = await this.getFacetStub(facetName)
			const forwardedRequest = new Request(
				buildFacetRequestUrl(request, facetName),
				request,
			)
			forwardedRequest.headers.set(appBackendHeader, facetName)
			const response = await facet.fetch(forwardedRequest)
			await this.recordSuccess()
			return response
		} catch (error) {
			if (error instanceof Response) {
				if ([404, 429, 503].includes(error.status)) {
					await this.recordSuccess()
				} else {
					await this.recordFailure(error)
				}
				return error
			}
			await this.recordFailure(error)
			return jsonResponse(
				{
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				},
				500,
			)
		}
	}

	async configure(input: {
		appId: string
		userId: string
		baseUrl?: string
		facetNames?: Array<string>
		serverCode: string | null
		serverCodeId: string
		rateLimitPerMinute?: number
		killSwitchEnabled?: boolean
	}) {
		const existing = await this.readConfig(input.appId)
		const nextConfig: AppRunnerConfig = {
			...existing,
			appId: input.appId,
			userId: input.userId,
			baseUrl: input.baseUrl ?? existing.baseUrl,
			facetNames: dedupeFacetNames(input.facetNames ?? existing.facetNames),
			serverCode: input.serverCode,
			serverCodeId: input.serverCodeId,
			rateLimitPerMinute:
				input.rateLimitPerMinute ?? existing.rateLimitPerMinute,
			killSwitchEnabled: input.killSwitchEnabled ?? existing.killSwitchEnabled,
		}
		await this.writeConfig(nextConfig)
		if (
			existing.serverCodeId !== nextConfig.serverCodeId ||
			existing.serverCode !== nextConfig.serverCode
		) {
			for (const facetName of dedupeFacetNames(nextConfig.facetNames)) {
				this.ctx.facets.abort(
					buildFacetName(facetName),
					new Error('Saved app server code updated.'),
				)
			}
		}
		return nextConfig
	}

	async getStatus(appId: string) {
		const config = await this.readConfig(appId)
		const metrics = await this.readMetrics()
		return {
			config,
			metrics,
			storageBytes: this.ctx.storage.sql.databaseSize,
		}
	}

	async resetStorage(input: { appId: string; facetName?: string | null }) {
		const facetName = buildFacetName(input.facetName)
		const facet = await this.getFacetStub(facetName)
		await (
			facet as unknown as { __kody_resetStorage: () => Promise<unknown> }
		).__kody_resetStorage()
		this.ctx.facets.abort(facetName, new Error('Facet storage reset.'))
		return {
			ok: true,
			appId: input.appId,
			facetName,
		}
	}

	async exportStorage(input: {
		appId: string
		facetName?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		const facetName = buildFacetName(input.facetName)
		const facet = await this.getFacetStub(facetName)
		const result = await (
			facet as unknown as {
				__kody_exportStorage: (payload?: {
					pageSize?: number
					startAfter?: string | null
				}) => Promise<FacetStorageExport>
			}
		).__kody_exportStorage({
			pageSize: input.pageSize,
			startAfter: input.startAfter ?? null,
		})
		return {
			ok: true,
			appId: input.appId,
			facetName,
			export: result,
		}
	}

	async execServer(input: {
		appId: string
		facetName?: string | null
		code: string
		params?: Record<string, unknown>
	}) {
		const facetName = buildFacetName(input.facetName)
		await this.getFacetStub(facetName)
		const config = await this.readConfig(this.ctx.id.toString())
		const execWorker = this.env.APP_LOADER.load({
			compatibilityDate: '2026-04-13',
			compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
			mainModule: 'exec-entry.js',
			modules: {
				'exec-entry.js': createSavedAppExecWorkerModule({
					code: input.code,
				}),
			},
			env: {
				APP: this.ctx.exports.AppFacetBridge({
					props: {
						appId: input.appId,
						userId: config.userId,
						baseUrl: config.baseUrl || 'http://internal.invalid',
						facetName,
					},
				}),
			},
			globalOutbound: null,
		}).getEntrypoint(savedAppExecEntrypointName) as unknown as {
			run: (params?: Record<string, unknown>) => Promise<unknown>
		}
		const result = await execWorker.run(input.params ?? {})
		return {
			ok: true,
			appId: input.appId,
			facetName,
			result,
		}
	}

	async deleteApp(input: { appId: string; facetNames?: Array<string> | null }) {
		for (const facetName of input.facetNames ?? ['main']) {
			this.ctx.facets.delete(buildFacetName(facetName))
		}
		await this.ctx.storage.deleteAll()
		return {
			ok: true,
			appId: input.appId,
		}
	}

	private async handleLifecycleAction(
		action: string,
		facetName: string,
		request: Request,
	) {
		const config = await this.readConfig(this.ctx.id.toString())
		const requestUserId = request.headers.get('X-Kody-App-User-Id')
		if (!config.userId) {
			return jsonResponse(
				{ ok: false, error: 'App runner is not configured.' },
				400,
			)
		}
		if (!requestUserId || requestUserId !== config.userId) {
			return jsonResponse(
				{ ok: false, error: 'Unauthorized saved app lifecycle request.' },
				403,
			)
		}
		switch (action) {
			case 'reset-storage':
				return jsonResponse(
					await this.resetStorage({
						appId: config.appId,
						facetName,
					}),
				)
			case 'export-storage': {
				const requestUrl = new URL(request.url)
				const pageSizeParam = requestUrl.searchParams.get('page_size')
				const startAfter = requestUrl.searchParams.get('start_after')
				return jsonResponse(
					await this.exportStorage({
						appId: config.appId,
						facetName,
						pageSize:
							pageSizeParam != null && pageSizeParam !== ''
								? Number(pageSizeParam)
								: undefined,
						startAfter,
					}),
				)
			}
			case 'exec-server': {
				const payload = await readJson<{
					code?: string
					params?: Record<string, unknown>
				}>(request)
				if (!payload?.code) {
					return jsonResponse(
						{ ok: false, error: 'exec-server requires code.' },
						400,
					)
				}
				return jsonResponse(
					await this.execServer({
						appId: config.appId,
						facetName,
						code: payload.code,
						params: payload.params,
					}),
				)
			}
			default:
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
		}
	}

	private async getFacetStub(facetName: string) {
		const config = await this.readConfig(this.ctx.id.toString())
		if (config.killSwitchEnabled) {
			throw jsonResponse(
				{ ok: false, error: 'Saved app backend is disabled.' },
				503,
			)
		}
		if (!hasUiArtifactServerCode(config.serverCode)) {
			throw jsonResponse(
				{
					ok: false,
					error: 'Saved app does not define server code for this facet.',
				},
				404,
			)
		}
		await this.registerFacetName(facetName)
		return this.ctx.facets.get(facetName, async () => {
			const worker = this.env.APP_LOADER.get(
				`${config.appId}:${facetName}:${config.serverCodeId}`,
				async () => ({
					compatibilityDate: '2026-04-13',
					compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
					mainModule: 'facet-entry.js',
					modules: {
						'facet-entry.js': createFacetWrapperModule({
							facetName,
						}),
						'user-app.js': config.serverCode!,
					},
					env: {
						KODY: this.ctx.exports.AppFacetBridge({
							props: {
								appId: config.appId,
								userId: config.userId,
								baseUrl: config.baseUrl || 'http://internal.invalid',
								facetName,
							},
						}),
					},
					globalOutbound: null,
				}),
			)
			return {
				id: `${appRunnerFacetIdPrefix}:${facetName}`,
				class: worker.getDurableObjectClass(
					buildFacetClassExportName(facetName),
				),
			}
		})
	}

	async callFacetRpc(input: {
		appId: string
		facetName?: string | null
		methodName: string
		args?: Array<unknown>
	}) {
		const facet = await this.getFacetStub(buildFacetName(input.facetName))
		const method = Reflect.get(facet, input.methodName)
		if (typeof method !== 'function') {
			throw new Error(
				`Saved app RPC method "${input.methodName}" was not found.`,
			)
		}
		return await Reflect.apply(method, facet, input.args ?? [])
	}

	private async applyRateLimit() {
		const config = await this.readConfig(this.ctx.id.toString())
		const now = Date.now()
		const existing =
			(await this.ctx.storage.get<AppRunnerRateWindow>(rateWindowStorageKey)) ??
			defaultRateWindow(now)
		const windowAgeMs = now - existing.windowStartedAt
		const windowState =
			windowAgeMs >= 60_000 ? defaultRateWindow(now) : existing
		if (windowState.requestCount >= config.rateLimitPerMinute) {
			throw jsonResponse(
				{ ok: false, error: 'Saved app backend rate limit exceeded.' },
				429,
			)
		}
		windowState.requestCount += 1
		await this.ctx.storage.put(rateWindowStorageKey, windowState)
	}

	private async readConfig(appId: string) {
		const existing =
			await this.ctx.storage.get<AppRunnerConfig>(configStorageKey)
		return existing ?? defaultConfig(appId)
	}

	private async writeConfig(config: AppRunnerConfig) {
		await this.ctx.storage.put(configStorageKey, config)
	}

	private async registerFacetName(facetName: string) {
		const config = await this.readConfig(this.ctx.id.toString())
		const nextFacetNames = dedupeFacetNames([...config.facetNames, facetName])
		if (nextFacetNames.length === config.facetNames.length) {
			return
		}
		await this.writeConfig({
			...config,
			facetNames: nextFacetNames,
		})
	}

	private async readMetrics() {
		return (
			(await this.ctx.storage.get<AppRunnerMetrics>(metricsStorageKey)) ??
			defaultMetrics()
		)
	}

	private async writeMetrics(metrics: AppRunnerMetrics) {
		await this.ctx.storage.put(metricsStorageKey, metrics)
	}

	private async recordSuccess() {
		const metrics = await this.readMetrics()
		metrics.requestCount += 1
		metrics.lastRequestAt = new Date().toISOString()
		await this.writeMetrics(metrics)
	}

	private async recordFailure(error: unknown) {
		const metrics = await this.readMetrics()
		const config = await this.readConfig(this.ctx.id.toString())
		metrics.requestCount += 1
		metrics.errorCount += 1
		metrics.lastRequestAt = new Date().toISOString()
		config.lastError =
			error instanceof Error
				? error.message
				: error instanceof Response
					? `HTTP ${error.status}`
					: String(error)
		await Promise.all([this.writeMetrics(metrics), this.writeConfig(config)])
	}
}

export const AppRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	AppRunnerBase,
)

export async function configureSavedAppRunner(input: {
	env: Env
	appId: string
	userId: string
	baseUrl?: string
	facetNames?: Array<string>
	serverCode: string | null
	serverCodeId: string
	rateLimitPerMinute?: number
	killSwitchEnabled?: boolean
}) {
	const runner = input.env.APP_RUNNER.get(
		input.env.APP_RUNNER.idFromName(input.appId),
	)
	return await (
		runner as unknown as {
			configure: (payload: {
				appId: string
				userId: string
				baseUrl?: string
				facetNames?: Array<string>
				serverCode: string | null
				serverCodeId: string
				rateLimitPerMinute?: number
				killSwitchEnabled?: boolean
			}) => Promise<AppRunnerConfig>
		}
	).configure({
		appId: input.appId,
		userId: input.userId,
		baseUrl: input.baseUrl,
		facetNames: input.facetNames,
		serverCode: input.serverCode,
		serverCodeId: input.serverCodeId,
		rateLimitPerMinute: input.rateLimitPerMinute,
		killSwitchEnabled: input.killSwitchEnabled,
	})
}

export async function deleteSavedAppRunner(input: { env: Env; appId: string }) {
	const runner = appRunnerRpc(input.env, input.appId)
	const status = await runner.getStatus({ appId: input.appId })
	return await runner.deleteApp({
		appId: input.appId,
		facetNames: status.config.facetNames,
	})
}

export function appRunnerRpc(env: Env, appId: string) {
	return env.APP_RUNNER.get(env.APP_RUNNER.idFromName(appId)) as unknown as {
		getStatus: (payload: { appId: string }) => Promise<{
			config: AppRunnerConfig
			metrics: AppRunnerMetrics
			storageBytes: number
		}>
		resetStorage: (payload: {
			appId: string
			facetName?: string | null
		}) => Promise<{ ok: true; appId: string; facetName: string }>
		exportStorage: (payload: {
			appId: string
			facetName?: string | null
			pageSize?: number
			startAfter?: string | null
		}) => Promise<{
			ok: true
			appId: string
			facetName: string
			export: FacetStorageExport
		}>
		execServer: (payload: {
			appId: string
			facetName?: string | null
			code: string
			params?: Record<string, unknown>
		}) => Promise<{
			ok: true
			appId: string
			facetName: string
			result: unknown
		}>
		callFacetRpc: (payload: {
			appId: string
			facetName?: string | null
			methodName: string
			args?: Array<unknown>
		}) => Promise<unknown>
		deleteApp: (payload: {
			appId: string
			facetNames?: Array<string> | null
		}) => Promise<{ ok: true; appId: string }>
	}
}

export async function exportSavedAppRunnerStorage(input: {
	env: Env
	appId: string
	facetName?: string | null
	pageSize?: number
	startAfter?: string | null
}) {
	return await appRunnerRpc(input.env, input.appId).exportStorage({
		appId: input.appId,
		facetName: input.facetName ?? 'main',
		pageSize: input.pageSize,
		startAfter: input.startAfter ?? null,
	})
}

export async function execSavedAppRunnerServer(input: {
	env: Env
	appId: string
	facetName?: string | null
	code: string
	params?: Record<string, unknown>
}) {
	return await appRunnerRpc(input.env, input.appId).execServer({
		appId: input.appId,
		facetName: input.facetName ?? 'main',
		code: input.code,
		params: input.params,
	})
}

export async function syncSavedAppRunnerFromDb(input: {
	env: Env
	appId: string
	userId: string
	baseUrl?: string
}) {
	const artifact = await getUiArtifactById(
		input.env.APP_DB,
		input.userId,
		input.appId,
	)
	if (!artifact) {
		await deleteSavedAppRunner({
			env: input.env,
			appId: input.appId,
		})
		return null
	}
	await configureSavedAppRunner({
		env: input.env,
		appId: artifact.id,
		userId: artifact.user_id,
		baseUrl: input.baseUrl,
		serverCode: artifact.serverCode,
		serverCodeId: artifact.serverCodeId,
	})
	return artifact
}

function dedupeFacetNames(facetNames: Array<string> | null | undefined) {
	const nextFacetNames = (facetNames ?? ['main'])
		.map((facetName) => buildFacetName(facetName))
		.filter(Boolean)
	return Array.from(new Set(nextFacetNames))
}
