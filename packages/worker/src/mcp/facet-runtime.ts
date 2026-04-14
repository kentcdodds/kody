import { WorkerEntrypoint } from 'cloudflare:workers'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { getValue, listValues, saveValue } from '#mcp/values/service.ts'
import {
	buildConnectorValueName,
	parseConnectorConfig,
	parseConnectorJson,
} from '#mcp/capabilities/values/connector-shared.ts'

export type FacetBridgeScope = 'app' | 'job' | 'user'

export type FacetBridgeProps = {
	userId: string
	baseUrl: string
	storageBindingId: string
	scopeLabel: 'app' | 'job'
	displayName: string
	facetName: string | null
}

export type FacetStorageExport = {
	entries: Array<{
		key: string
		value: unknown
	}>
	estimatedBytes: number
}

export type FacetErrorDetails = {
	message: string
	stack: string | null
}

type CreateFacetStartupInput = {
	loader: WorkerLoader
	cacheKey: string
	serverCode: string
	facetName: string
	baseClassName: string
	expectedExportDescription: string
	facetIdPrefix: string
	bridgeBindingName: string
	bridgeBinding: Fetcher
}

const defaultCompatibilityDate = '2026-03-24'
const defaultCompatibilityFlags = [
	'nodejs_compat',
	'global_fetch_strictly_public',
]
const defaultFacetModuleName = 'user-facet.js'

function createScopedStorageContext(storageBindingId: string) {
	return {
		sessionId: null,
		appId: storageBindingId,
	}
}

function normalizeBridgeScope(
	scope: FacetBridgeScope | undefined,
	defaultScope: FacetBridgeProps['scopeLabel'],
) {
	const resolvedScope = scope ?? defaultScope
	return resolvedScope === 'user' ? 'user' : 'app'
}

export function normalizeFacetName(
	rawFacetName: string | null | undefined,
	fallback = 'main',
) {
	const facetName = rawFacetName?.trim() || fallback
	return facetName
}

export function buildFacetClassExportName(
	baseClassName: string,
	facetName: string,
) {
	return facetName === 'main'
		? baseClassName
		: `${baseClassName}_${facetName.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`
}

export function readJson<TPayload>(request: Request): Promise<TPayload | null> {
	return request.json().catch(() => null) as Promise<TPayload | null>
}

export function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}

export function toFacetErrorDetails(error: unknown): FacetErrorDetails {
	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack ?? null,
		}
	}
	if (error instanceof Response) {
		return {
			message: `HTTP ${error.status}`,
			stack: null,
		}
	}
	return {
		message: String(error),
		stack: null,
	}
}

function createFacetWrapperModule(input: {
	baseClassName: string
	expectedExportDescription: string
	facetName: string
	serverCode: string
}) {
	const exportName = buildFacetClassExportName(
		input.baseClassName,
		input.facetName,
	)
	return `
import * as userModule from './${defaultFacetModuleName}'

const BaseFacet = userModule.${input.baseClassName}

if (typeof BaseFacet !== 'function') {
	throw new Error('${input.expectedExportDescription}')
}

export class ${exportName} extends BaseFacet {
	async __kody_resetStorage() {
		await this.ctx.storage.deleteAll()
		return { ok: true }
	}

	async __kody_exportStorage() {
		const entries = []
		for (const [key, value] of await this.ctx.storage.list()) {
			entries.push({ key, value })
		}
		return {
			entries,
			estimatedBytes: this.ctx.storage.sql.databaseSize,
		}
	}

	async __kody_exec(code, params) {
		if (typeof code !== 'string' || !code.trim()) {
			throw new Error('Facet exec requires non-empty code.')
		}
		const runner = new Function('facet', 'params', code)
		return await runner(this, params ?? {})
	}
}
`.trim()
}

export async function createFacetStartup(input: CreateFacetStartupInput) {
	const exportName = buildFacetClassExportName(
		input.baseClassName,
		input.facetName,
	)
	const worker = input.loader.get(input.cacheKey, async () => ({
		compatibilityDate: defaultCompatibilityDate,
		compatibilityFlags: defaultCompatibilityFlags,
		mainModule: 'facet-entry.js',
		modules: {
			'facet-entry.js': createFacetWrapperModule({
				baseClassName: input.baseClassName,
				expectedExportDescription: input.expectedExportDescription,
				facetName: input.facetName,
				serverCode: input.serverCode,
			}),
			[defaultFacetModuleName]: input.serverCode,
		},
		env: {
			[input.bridgeBindingName]: input.bridgeBinding,
		},
		globalOutbound: null,
	}))
	return {
		id: `${input.facetIdPrefix}:${input.facetName}`,
		class: worker.getDurableObjectClass(exportName),
	}
}

export async function callFacetStorageReset(facet: Fetcher) {
	return await (
		facet as unknown as {
			__kody_resetStorage: () => Promise<unknown>
		}
	).__kody_resetStorage()
}

export async function callFacetStorageExport(facet: Fetcher) {
	return await (
		facet as unknown as {
			__kody_exportStorage: () => Promise<FacetStorageExport>
		}
	).__kody_exportStorage()
}

export class FacetKodyBridge extends WorkerEntrypoint<Env, FacetBridgeProps> {
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
				storageContext: createScopedStorageContext(
					this.ctx.props.storageBindingId,
				),
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

	async fetchViaHostGateway(input: {
		url: string
		method?: string
		headers?: Record<string, string>
		body?: string
	}) {
		const gateway = this.ctx.exports.CodemodeFetchGateway({
			props: {
				baseUrl: this.ctx.props.baseUrl,
				userId: this.ctx.props.userId,
				storageContext: createScopedStorageContext(
					this.ctx.props.storageBindingId,
				),
			},
		}) as {
			fetch: (request: Request) => Promise<Response>
		}
		const request = new Request(input.url, {
			method: input.method ?? 'GET',
			headers: input.headers,
			body: input.body,
		})
		const response = await gateway.fetch(request)
		return {
			status: response.status,
			statusText: response.statusText,
			headers: Object.fromEntries(response.headers.entries()),
			body: await response.text(),
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
			storageContext: createScopedStorageContext(
				this.ctx.props.storageBindingId,
			),
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
			storageContext: createScopedStorageContext(
				this.ctx.props.storageBindingId,
			),
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

	async valueGet(
		name: string,
		scope: FacetBridgeScope = this.ctx.props.scopeLabel,
	) {
		return await getValue({
			env: this.env,
			userId: this.ctx.props.userId,
			name,
			scope: normalizeBridgeScope(scope, this.ctx.props.scopeLabel),
			storageContext: createScopedStorageContext(
				this.ctx.props.storageBindingId,
			),
		})
	}

	async valueSet(input: {
		name: string
		value: string
		description?: string
		scope?: FacetBridgeScope
	}) {
		return await saveValue({
			env: this.env,
			userId: this.ctx.props.userId,
			name: input.name,
			value: input.value,
			description: input.description ?? '',
			scope: normalizeBridgeScope(input.scope, this.ctx.props.scopeLabel),
			storageContext: createScopedStorageContext(
				this.ctx.props.storageBindingId,
			),
		})
	}

	async secretPlaceholder(
		name: string,
		scope: FacetBridgeScope = this.ctx.props.scopeLabel,
	) {
		const resolvedScope = normalizeBridgeScope(scope, this.ctx.props.scopeLabel)
		const resolved = await resolveSecret({
			env: this.env,
			userId: this.ctx.props.userId,
			name,
			scope: resolvedScope,
			storageContext: createScopedStorageContext(
				this.ctx.props.storageBindingId,
			),
		})
		if (!resolved.found) {
			throw new Error(`Secret "${name}" was not found.`)
		}
		return `{{secret:${name}|scope=${resolvedScope}}}`
	}

	async metaRunSkill(
		name: string,
		params: Record<string, unknown> | undefined,
	) {
		const { metaRunSkillCapability } =
			await import('#mcp/capabilities/meta/meta-run-skill.ts')
		return await metaRunSkillCapability.handler(
			{ name, params },
			{
				env: this.env,
				callerContext: createMcpCallerContext({
					baseUrl: this.ctx.props.baseUrl,
					user: {
						userId: this.ctx.props.userId,
						email: '',
						displayName: this.ctx.props.displayName,
					},
					storageContext: createScopedStorageContext(
						this.ctx.props.storageBindingId,
					),
				}),
			},
		)
	}
}
