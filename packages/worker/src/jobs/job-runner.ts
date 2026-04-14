import * as Sentry from '@sentry/cloudflare'
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { getValue, listValues, saveValue } from '#mcp/values/service.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import {
	buildConnectorValueName,
	parseConnectorConfig,
	parseConnectorJson,
} from '#mcp/capabilities/values/connector-shared.ts'

const defaultJobFacetName = 'main'
const defaultStorageExportPageSize = 250
const maxStorageExportPageSize = 1_000
const jobFacetClassExportName = 'JobFacet'
const jobExecEntrypointName = 'JobExecWorker'

type JobRunnerConfig = {
	jobId: string
	userId: string
	baseUrl: string
	storageContext: {
		sessionId: string | null
		appId: string | null
	}
	serverCode: string
	serverCodeId: string
	methodName: string
	killSwitchEnabled: boolean
	lastError: string | null
}

type JobBridgeProps = {
	jobId: string
	userId: string
	baseUrl: string
	storageContext: {
		sessionId: string | null
		appId: string | null
	}
	facetName: string
}

type JobStorageExport = {
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

function createFacetWrapperModule() {
	return `
import * as userModule from './user-job.js'

const BaseJob = userModule.Job
const reservedMethodNames = new Set([
	'fetch',
	'alarm',
	'webSocketMessage',
	'webSocketClose',
	'webSocketError',
	'__kody_resetStorage',
	'__kody_exportStorage',
	'__kody_invokeUserMethod',
])

if (typeof BaseJob !== 'function') {
	throw new Error('Facet job server code must export class Job extends DurableObject.')
}

export class ${jobFacetClassExportName} extends BaseJob {
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

	async __kody_invokeUserMethod(methodName, args) {
		if (typeof methodName !== 'string' || !methodName.trim()) {
			throw new Error('Job RPC method name must be a non-empty string.')
		}
		const normalizedMethodName = methodName.trim()
		if (
			reservedMethodNames.has(normalizedMethodName) ||
			normalizedMethodName.startsWith('__kody_')
		) {
			throw new Error(\`Job RPC method "\${normalizedMethodName}" is not allowed.\`)
		}
		const method = Reflect.get(this, normalizedMethodName)
		if (typeof method !== 'function') {
			throw new Error(\`Job RPC method "\${normalizedMethodName}" was not found.\`)
		}
		return await Reflect.apply(
			method,
			this,
			Array.isArray(args) ? args : [],
		)
	}
}
	`.trim()
}

function createJobExecWorkerModule(input: { code: string }) {
	return `
import { WorkerEntrypoint } from 'cloudflare:workers'

export class ${jobExecEntrypointName} extends WorkerEntrypoint {
	async run(params) {
		const job = {
			call: (methodName, ...args) => {
				return this.env.JOB.callJobRpc(methodName, args)
			},
		}
		const __kodyUserCode = (${input.code})
		return await __kodyUserCode(params)
	}
}
	`.trim()
}

function normalizeStorageContext(
	storageContext:
		| {
				sessionId?: string | null
				appId?: string | null
		  }
		| null
		| undefined,
) {
	return {
		sessionId: storageContext?.sessionId ?? null,
		appId: storageContext?.appId ?? null,
	}
}

function defaultConfig(jobId: string): JobRunnerConfig {
	return {
		jobId,
		userId: '',
		baseUrl: '',
		storageContext: {
			sessionId: null,
			appId: null,
		},
		serverCode: '',
		serverCodeId: crypto.randomUUID(),
		methodName: 'run',
		killSwitchEnabled: false,
		lastError: null,
	}
}

export class JobFacetBridge extends WorkerEntrypoint<Env, JobBridgeProps> {
	async callJobRpc(methodName: string, args: Array<unknown> = []) {
		return await jobRunnerRpc(this.env, this.ctx.props.jobId).callJobRpc({
			jobId: this.ctx.props.jobId,
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
				storageContext: this.ctx.props.storageContext,
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
			storageContext: this.ctx.props.storageContext,
		})
		if (!value) {
			return { connector: null }
		}
		return {
			connector: parseConnectorConfig(parseConnectorJson(value.value), name),
		}
	}

	async connectorList() {
		const values = await listValues({
			env: this.env,
			userId: this.ctx.props.userId,
			scope: 'user',
			storageContext: this.ctx.props.storageContext,
		})
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
			storageContext: this.ctx.props.storageContext,
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
			storageContext: this.ctx.props.storageContext,
		})
	}

	async secretPlaceholder(name: string, scope: 'app' | 'user' = 'app') {
		const resolved = await resolveSecret({
			env: this.env,
			userId: this.ctx.props.userId,
			name,
			scope,
			storageContext: this.ctx.props.storageContext,
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
						displayName: `job:${this.ctx.props.jobId}`,
					},
					storageContext: this.ctx.props.storageContext,
				}),
			},
		)
	}
}

class JobRunnerBase extends DurableObject<Env> {
	async configure(input: {
		jobId: string
		userId: string
		baseUrl?: string
		storageContext?: {
			sessionId?: string | null
			appId?: string | null
		} | null
		serverCode: string
		serverCodeId: string
		methodName?: string | null
		killSwitchEnabled?: boolean
	}) {
		const existing = await this.readConfig(input.jobId)
		const nextConfig: JobRunnerConfig = {
			...existing,
			jobId: input.jobId,
			userId: input.userId,
			baseUrl: input.baseUrl ?? existing.baseUrl,
			storageContext:
				input.storageContext === undefined
					? existing.storageContext
					: normalizeStorageContext(input.storageContext),
			serverCode: input.serverCode,
			serverCodeId: input.serverCodeId,
			methodName: input.methodName?.trim() || existing.methodName || 'run',
			killSwitchEnabled: input.killSwitchEnabled ?? existing.killSwitchEnabled,
		}
		await this.writeConfig(nextConfig)
		if (
			existing.serverCodeId !== nextConfig.serverCodeId ||
			existing.serverCode !== nextConfig.serverCode
		) {
			this.ctx.facets.abort(defaultJobFacetName, new Error('Job code updated.'))
		}
		return nextConfig
	}

	async resetStorage(input: { jobId: string; facetName?: string | null }) {
		const facetName = input.facetName?.trim() || defaultJobFacetName
		const facet = await this.getFacetStub(input.jobId, facetName)
		await (
			facet as unknown as { __kody_resetStorage: () => Promise<unknown> }
		).__kody_resetStorage()
		this.ctx.facets.abort(facetName, new Error('Facet storage reset.'))
		return {
			ok: true,
			jobId: input.jobId,
			facetName,
		}
	}

	async exportStorage(input: {
		jobId: string
		facetName?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		const facetName = input.facetName?.trim() || defaultJobFacetName
		const facet = await this.getFacetStub(input.jobId, facetName)
		const result = await (
			facet as unknown as {
				__kody_exportStorage: (payload?: {
					pageSize?: number
					startAfter?: string | null
				}) => Promise<JobStorageExport>
			}
		).__kody_exportStorage({
			pageSize: input.pageSize,
			startAfter: input.startAfter ?? null,
		})
		return {
			ok: true,
			jobId: input.jobId,
			facetName,
			export: result,
		}
	}

	async runStoredJob(input: {
		jobId: string
		facetName?: string | null
		methodName?: string | null
		params?: Record<string, unknown>
	}) {
		const config = await this.readConfig(input.jobId)
		const methodName = input.methodName?.trim() || config.methodName || 'run'
		const result = await this.callJobRpc({
			jobId: input.jobId,
			facetName: input.facetName ?? defaultJobFacetName,
			methodName,
			args: input.params === undefined ? [] : [input.params],
		})
		return {
			ok: true,
			jobId: input.jobId,
			methodName,
			result,
		}
	}

	async execServer(input: {
		jobId: string
		facetName?: string | null
		code: string
		params?: Record<string, unknown>
	}) {
		const facetName = input.facetName?.trim() || defaultJobFacetName
		await this.getFacetStub(input.jobId, facetName)
		const config = await this.readConfig(input.jobId)
		const execWorker = this.env.APP_LOADER.load({
			compatibilityDate: '2026-04-13',
			compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
			mainModule: 'exec-entry.js',
			modules: {
				'exec-entry.js': createJobExecWorkerModule({
					code: input.code,
				}),
			},
			env: {
				JOB: this.ctx.exports.JobFacetBridge({
					props: {
						jobId: input.jobId,
						userId: config.userId,
						baseUrl: config.baseUrl || 'http://internal.invalid',
						storageContext: config.storageContext,
						facetName,
					},
				}),
			},
			globalOutbound: null,
		}).getEntrypoint(jobExecEntrypointName) as unknown as {
			run: (params?: Record<string, unknown>) => Promise<unknown>
		}
		const result = await execWorker.run(input.params ?? {})
		return {
			ok: true,
			jobId: input.jobId,
			facetName,
			result,
		}
	}

	async callJobRpc(input: {
		jobId: string
		facetName?: string | null
		methodName: string
		args?: Array<unknown>
	}) {
		const facetName = input.facetName?.trim() || defaultJobFacetName
		const facet = await this.getFacetStub(input.jobId, facetName)
		return await (
			facet as unknown as {
				__kody_invokeUserMethod: (
					methodName: string,
					args?: Array<unknown>,
				) => Promise<unknown>
			}
		).__kody_invokeUserMethod(input.methodName, input.args ?? [])
	}

	async deleteJob(input: { jobId: string }) {
		this.ctx.facets.delete(defaultJobFacetName)
		await this.ctx.storage.deleteAll()
		return {
			ok: true,
			jobId: input.jobId,
		}
	}

	private async getFacetStub(jobId: string, facetName: string) {
		const config = await this.readConfig(jobId)
		if (config.killSwitchEnabled) {
			throw new Error('Facet job backend is disabled.')
		}
		if (!config.serverCode.trim()) {
			throw new Error('Facet job does not define server code.')
		}
		return this.ctx.facets.get(facetName, async () => {
			const worker = this.env.APP_LOADER.get(
				`${config.jobId}:${facetName}:${config.serverCodeId}`,
				async () => ({
					compatibilityDate: '2026-04-13',
					compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
					mainModule: 'facet-entry.js',
					modules: {
						'facet-entry.js': createFacetWrapperModule(),
						'user-job.js': config.serverCode,
					},
					env: {
						KODY: this.ctx.exports.JobFacetBridge({
							props: {
								jobId: config.jobId,
								userId: config.userId,
								baseUrl: config.baseUrl || 'http://internal.invalid',
								storageContext: config.storageContext,
								facetName,
							},
						}),
					},
					globalOutbound: null,
				}),
			)
			return {
				id: `facet:${facetName}`,
				class: worker.getDurableObjectClass(jobFacetClassExportName),
			}
		})
	}

	private async readConfig(jobId: string) {
		const existing =
			await this.ctx.storage.get<JobRunnerConfig>(configStorageKey)
		return existing ?? defaultConfig(jobId)
	}

	private async writeConfig(config: JobRunnerConfig) {
		await this.ctx.storage.put(configStorageKey, config)
	}
}

export const JobRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	JobRunnerBase,
)

export async function configureJobRunner(input: {
	env: Env
	jobId: string
	userId: string
	baseUrl?: string
	storageContext?: {
		sessionId?: string | null
		appId?: string | null
	} | null
	serverCode: string
	serverCodeId: string
	methodName?: string | null
	killSwitchEnabled?: boolean
}) {
	return await jobRunnerRpc(input.env, input.jobId).configure({
		jobId: input.jobId,
		userId: input.userId,
		baseUrl: input.baseUrl,
		storageContext: input.storageContext,
		serverCode: input.serverCode,
		serverCodeId: input.serverCodeId,
		methodName: input.methodName,
		killSwitchEnabled: input.killSwitchEnabled,
	})
}

export async function deleteJobRunner(input: { env: Env; jobId: string }) {
	return await jobRunnerRpc(input.env, input.jobId).deleteJob({
		jobId: input.jobId,
	})
}

export function jobRunnerRpc(env: Env, jobId: string) {
	return env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(jobId)) as unknown as {
		configure: (payload: {
			jobId: string
			userId: string
			baseUrl?: string
			storageContext?: {
				sessionId?: string | null
				appId?: string | null
			} | null
			serverCode: string
			serverCodeId: string
			methodName?: string | null
			killSwitchEnabled?: boolean
		}) => Promise<JobRunnerConfig>
		resetStorage: (payload: {
			jobId: string
			facetName?: string | null
		}) => Promise<{ ok: true; jobId: string; facetName: string }>
		exportStorage: (payload: {
			jobId: string
			facetName?: string | null
			pageSize?: number
			startAfter?: string | null
		}) => Promise<{
			ok: true
			jobId: string
			facetName: string
			export: JobStorageExport
		}>
		runStoredJob: (payload: {
			jobId: string
			facetName?: string | null
			methodName?: string | null
			params?: Record<string, unknown>
		}) => Promise<{
			ok: true
			jobId: string
			methodName: string
			result: unknown
		}>
		execServer: (payload: {
			jobId: string
			facetName?: string | null
			code: string
			params?: Record<string, unknown>
		}) => Promise<{
			ok: true
			jobId: string
			facetName: string
			result: unknown
		}>
		callJobRpc: (payload: {
			jobId: string
			facetName?: string | null
			methodName: string
			args?: Array<unknown>
		}) => Promise<unknown>
		deleteJob: (payload: { jobId: string }) => Promise<{
			ok: true
			jobId: string
		}>
	}
}
