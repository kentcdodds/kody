/// <reference lib="dom" />
import { createWidgetHostBridge } from './widget-host-bridge.js'
import { initializeGeneratedUiRuntime } from './generated-ui-widget-runtime.ts'
import {
	buildGeneratedUiRuntimeImportMap,
	type GeneratedUiAppSessionBootstrap,
	type GeneratedUiRuntimeBootstrap,
	generatedUiRuntimeModuleSpecifier,
} from './generated-ui-runtime-contract.ts'
import {
	escapeInlineScriptSource,
	injectIntoHtmlDocument,
	renderGeneratedUiDocument,
	renderGeneratedUiErrorDocument,
} from '@kody-internal/shared/generated-ui-documents.ts'
import {
	generatedUiRuntimeScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'

export {
	absolutizeHtmlAttributeUrls,
	injectIntoHtmlDocument,
} from '@kody-internal/shared/generated-ui-documents.ts'
export {
	buildGeneratedUiRuntimeImportMap,
	type GeneratedUiAppSessionBootstrap,
	type GeneratedUiRuntimeBootstrap,
	generatedUiRuntimeModuleSpecifier,
} from './generated-ui-runtime-contract.ts'
export {
	getOrCreateKodyWidgetReadyStateForTest,
	getKodyWidget,
	kodyWidget,
	whenKodyWidgetReady,
	type KodyWidgetPublicApi,
} from './generated-ui-widget-runtime.ts'

type RenderMode = 'inline_code' | 'saved_app'
type AppRuntime = 'html' | 'javascript'
type DisplayMode = 'inline' | 'fullscreen' | 'pip'

type AppSessionEnvelope = {
	sessionId: string
	expiresAt: string
	endpoints: {
		source: string
		execute: string
		secrets: string
		deleteSecret: string
	}
	token?: string
}

type AppSessionHttpContext = {
	token?: string
	endpoints: AppSessionEnvelope['endpoints']
}

type RenderEnvelope = {
	mode: RenderMode
	code?: string
	appId?: string
	runtime?: AppRuntime
	params?: Record<string, unknown>
	appSession?: AppSessionEnvelope | null
}

type RenderDataEnvelope = {
	toolOutput?: Record<string, unknown>
	theme?: string
	displayMode?: string
	availableDisplayModes?: Array<string>
}

type MeasuredFrameSize = {
	height: number
	width: number
}

type SizeMeasurementElement = {
	scrollHeight?: number
	scrollWidth?: number
	offsetHeight?: number
	offsetWidth?: number
	getBoundingClientRect?: () => {
		height?: number
		width?: number
	}
}

type SizeMeasurementDocument = {
	body?: SizeMeasurementElement | null
	documentElement?: SizeMeasurementElement | null
}

type HostToolResult = {
	structuredContent?: unknown
	isError?: boolean
}

type SavedAppSourceFromHostToolResult =
	| {
			handled: false
	  }
	| {
			handled: true
			code: string
			runtime: AppRuntime
	  }
	| {
			handled: true
			errorMessage: string
	  }

function coerceJsonRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined
	}
	const out: Record<string, unknown> = Object.create(null)
	for (const [key, entry] of Object.entries(value)) {
		out[key] = entry
	}
	return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeMeasuredValue(value: unknown) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return 0
	}
	return Math.ceil(value)
}

function measureElementDimensions(
	element: SizeMeasurementElement | null | undefined,
) {
	if (!element) return { height: 0, width: 0 }
	const rect = element.getBoundingClientRect?.()
	return {
		height: Math.max(
			normalizeMeasuredValue(element.scrollHeight),
			normalizeMeasuredValue(element.offsetHeight),
			normalizeMeasuredValue(rect?.height),
		),
		width: Math.max(
			normalizeMeasuredValue(element.scrollWidth),
			normalizeMeasuredValue(element.offsetWidth),
			normalizeMeasuredValue(rect?.width),
		),
	}
}

export function measureRenderedFrameSize(
	documentRef: SizeMeasurementDocument | null | undefined,
): MeasuredFrameSize | null {
	if (!documentRef) return null
	const documentElementSize = measureElementDimensions(
		documentRef.documentElement,
	)
	const bodySize = measureElementDimensions(documentRef.body)
	const nextSize = {
		height: Math.max(documentElementSize.height, bodySize.height),
		width: Math.max(documentElementSize.width, bodySize.width),
	}
	return nextSize.height > 0 || nextSize.width > 0 ? nextSize : null
}

function coerceRuntime(value: unknown): AppRuntime | undefined {
	return value === 'html' || value === 'javascript' ? value : undefined
}

function coerceAppSession(value: unknown): AppSessionEnvelope | null {
	if (!isRecord(value)) return null
	if (
		typeof value.sessionId !== 'string' ||
		typeof value.expiresAt !== 'string'
	) {
		return null
	}
	const endpoints = coerceGeneratedUiEndpoints(value.endpoints)
	if (!endpoints) {
		return null
	}
	return {
		sessionId: value.sessionId,
		expiresAt: value.expiresAt,
		endpoints,
		token: typeof value.token === 'string' ? value.token : undefined,
	}
}

function coerceGeneratedUiEndpoints(value: unknown) {
	if (!isRecord(value)) return null
	if (
		typeof value.source !== 'string' ||
		typeof value.execute !== 'string' ||
		typeof value.secrets !== 'string' ||
		typeof value.deleteSecret !== 'string'
	) {
		return null
	}
	try {
		const source = new URL(value.source)
		const execute = new URL(value.execute)
		const secrets = new URL(value.secrets)
		const deleteSecret = new URL(value.deleteSecret)
		const origin = source.origin
		const expectedOrigin = new URL('/', import.meta.url).origin
		if (origin !== expectedOrigin) {
			return null
		}
		if (
			execute.origin !== origin ||
			secrets.origin !== origin ||
			deleteSecret.origin !== origin
		) {
			return null
		}
		if (
			!source.pathname.startsWith('/ui-api/') ||
			!execute.pathname.startsWith('/ui-api/') ||
			!secrets.pathname.startsWith('/ui-api/') ||
			!deleteSecret.pathname.startsWith('/ui-api/')
		) {
			return null
		}
		return {
			source: source.toString(),
			execute: execute.toString(),
			secrets: secrets.toString(),
			deleteSecret: deleteSecret.toString(),
		}
	} catch {
		return null
	}
}

export function injectRuntimeStateIntoDocument(
	code: string,
	params: Record<string, unknown> | undefined,
) {
	const runtimeBootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'mcp',
		params: params ?? {},
	}
	const bootstrapJson = escapeInlineScriptSource(
		JSON.stringify(runtimeBootstrap),
	)
	const bootstrapScript = `
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
window.__kodyAppParams = window.__kodyGeneratedUiBootstrap.params ?? {};
window.params = window.__kodyAppParams;
</script>
	`.trim()
	return injectIntoHtmlDocument(code, bootstrapScript)
}

export function buildCodemodeCapabilityExecuteCode(
	name: string,
	args: Record<string, unknown> = {},
) {
	return [
		'async () => {',
		`  return await codemode[${JSON.stringify(name)}](${JSON.stringify(args)});`,
		'}',
	].join('\n')
}

function getHostToolErrorMessage(result: HostToolResult | null) {
	if (!result || result.isError !== true) return null
	const structuredContent = isRecord(result.structuredContent)
		? result.structuredContent
		: null
	const error = isRecord(structuredContent?.error)
		? structuredContent.error
		: null
	return typeof error?.message === 'string'
		? error.message
		: 'Code execution failed.'
}

export function readSavedAppSourceFromHostToolResult(
	result: HostToolResult | null,
): SavedAppSourceFromHostToolResult {
	if (!result) {
		return {
			handled: false as const,
		}
	}
	const errorMessage = getHostToolErrorMessage(result)
	if (errorMessage) {
		return {
			handled: true as const,
			errorMessage,
		}
	}
	const structuredContent = isRecord(result.structuredContent)
		? result.structuredContent
		: null
	const code =
		typeof structuredContent?.code === 'string' ? structuredContent.code : null
	if (!code) {
		return {
			handled: true as const,
			errorMessage: 'Saved app source is missing code.',
		}
	}
	return {
		handled: true as const,
		code,
		runtime: coerceRuntime(structuredContent?.runtime) ?? 'html',
	}
}

async function executeCodeWithHostTool(
	hostBridge: ReturnType<typeof createWidgetHostBridge>,
	code: string,
) {
	const result = (await hostBridge.callTool({
		name: 'execute',
		arguments: { code },
		timeoutMs: 90_000,
	})) as HostToolResult | null
	const errorMessage = getHostToolErrorMessage(result)
	if (errorMessage) {
		throw new Error(errorMessage)
	}
	const structuredContent = isRecord(result?.structuredContent)
		? result.structuredContent
		: null
	return structuredContent?.result ?? null
}

function coerceRenderEnvelope(value: unknown): RenderEnvelope | null {
	if (!isRecord(value)) return null
	const renderSource = value.renderSource ?? value.mode
	if (renderSource !== 'inline_code' && renderSource !== 'saved_app')
		return null
	const code =
		typeof value.sourceCode === 'string'
			? value.sourceCode
			: typeof value.code === 'string'
				? value.code
				: undefined
	const appId = typeof value.appId === 'string' ? value.appId : undefined
	const runtime = coerceRuntime(value.runtime) ?? (code ? 'html' : undefined)
	const params = coerceJsonRecord(value.params)
	const appSession = coerceAppSession(value.appSession)
	return { mode: renderSource, code, appId, runtime, params, appSession }
}

function getEnvelopeFromRenderData(renderData: RenderDataEnvelope | undefined) {
	const toolOutput = isRecord(renderData?.toolOutput)
		? renderData.toolOutput
		: undefined
	return coerceRenderEnvelope(toolOutput)
}

type GeneratedUiRuntimeMode = 'entry' | 'hosted' | 'mcp'

type GeneratedUiRuntimeHooks = {
	sendMessage?: (text: string) => boolean | Promise<boolean>
	openLink?: (url: string) => boolean | Promise<boolean>
	requestDisplayMode?: (
		mode: DisplayMode,
	) => DisplayMode | null | Promise<DisplayMode | null>
	executeCode?: (code: string) => unknown | Promise<unknown>
}

type GeneratedUiWindow = Window &
	typeof globalThis & {
		__kodyGeneratedUiBootstrap?: GeneratedUiRuntimeBootstrap
		__kodyGeneratedUiRuntimeHooks?: GeneratedUiRuntimeHooks
	}

function getBaseHref() {
	try {
		return new URL('/', import.meta.url).toString()
	} catch {
		return null
	}
}

function readGeneratedUiBootstrap(): GeneratedUiRuntimeBootstrap {
	const win = globalThis.window as GeneratedUiWindow | undefined
	const bootstrap = win?.__kodyGeneratedUiBootstrap
	if (!isRecord(bootstrap)) {
		return { mode: 'entry' }
	}
	return {
		mode:
			bootstrap.mode === 'entry' ||
			bootstrap.mode === 'hosted' ||
			bootstrap.mode === 'mcp'
				? bootstrap.mode
				: 'entry',
		params: coerceJsonRecord(bootstrap.params),
		appSession: coerceAppSession(bootstrap.appSession),
	}
}

async function fetchJsonResponse(input: {
	url: string
	method?: 'GET' | 'POST'
	body?: Record<string, unknown>
	token?: string
}) {
	const headers = new Headers({
		Accept: 'application/json',
	})
	if (input.body) {
		headers.set('Content-Type', 'application/json')
	}
	if (input.token) {
		headers.set('Authorization', `Bearer ${input.token}`)
	}
	const response = await fetch(input.url, {
		method: input.method ?? 'GET',
		headers,
		body: input.body ? JSON.stringify(input.body) : undefined,
		cache: 'no-store',
		credentials: input.token ? 'omit' : 'include',
	})
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	return { response, payload }
}

function getApiErrorMessage(
	payload: Record<string, unknown> | null,
	fallback: string,
) {
	return typeof payload?.error === 'string' ? payload.error : fallback
}

function getSessionRequestTarget(
	appSession: AppSessionHttpContext | null | undefined,
	type: 'execute' | 'secrets' | 'delete-secret',
) {
	if (!appSession?.token) {
		return null
	}
	const url =
		type === 'execute'
			? appSession.endpoints.execute
			: type === 'secrets'
				? appSession.endpoints.secrets
				: appSession.endpoints.deleteSecret
	return {
		url,
		token: appSession.token,
	}
}

async function executeCodeWithHttp(
	appSession: AppSessionHttpContext | null | undefined,
	code: string,
) {
	const target = getSessionRequestTarget(appSession, 'execute')
	if (!target) {
		return {
			handled: false,
			result: null,
		}
	}
	const { response, payload } = await fetchJsonResponse({
		url: target.url,
		method: 'POST',
		body: { code },
		token: target.token,
	})
	if (!response.ok || !payload || payload.ok !== true) {
		throw new Error(getApiErrorMessage(payload, 'Code execution failed.'))
	}
	return {
		handled: true,
		result: payload.result ?? null,
	}
}

function buildSavedUiEndpoint(
	baseHref: string | null,
	uiId: string,
	endpoint: 'source' | 'execute' | 'secrets' | 'delete-secret',
) {
	if (!baseHref) {
		return null
	}
	const path =
		endpoint === 'delete-secret'
			? `/ui-api/${encodeURIComponent(uiId)}/secrets/delete`
			: `/ui-api/${encodeURIComponent(uiId)}/${endpoint}`
	return new URL(path, baseHref).toString()
}

async function observeRenderedDocumentSize(
	hostBridge: ReturnType<typeof createWidgetHostBridge>,
) {
	const documentRef = globalThis.document
	if (!documentRef) {
		return () => {}
	}
	let lastMeasuredSize: MeasuredFrameSize | null = null
	let sizeMeasurementScheduled = false
	const notifyMeasuredSize = async () => {
		const nextSize = measureRenderedFrameSize(documentRef)
		if (
			!nextSize ||
			(lastMeasuredSize?.height === nextSize.height &&
				lastMeasuredSize?.width === nextSize.width)
		) {
			return
		}
		lastMeasuredSize = nextSize
		await hostBridge.sendSizeChanged(nextSize)
	}
	const scheduleMeasuredSizeNotification = () => {
		if (sizeMeasurementScheduled) return
		sizeMeasurementScheduled = true
		globalThis.requestAnimationFrame(() => {
			sizeMeasurementScheduled = false
			void notifyMeasuredSize()
		})
	}
	const observedElements = [
		documentRef.documentElement,
		documentRef.body,
	].filter((element): element is HTMLElement => element != null)
	let resizeObserver: ResizeObserver | null = null
	if (typeof ResizeObserver === 'function' && observedElements.length > 0) {
		resizeObserver = new ResizeObserver(() => {
			scheduleMeasuredSizeNotification()
		})
		for (const element of observedElements) {
			resizeObserver.observe(element)
		}
	}
	globalThis.addEventListener('resize', scheduleMeasuredSizeNotification)
	globalThis.setTimeout(() => {
		scheduleMeasuredSizeNotification()
	}, 0)
	scheduleMeasuredSizeNotification()
	return () => {
		resizeObserver?.disconnect()
		globalThis.removeEventListener('resize', scheduleMeasuredSizeNotification)
	}
}

function writeDocument(html: string) {
	const documentRef = globalThis.document
	if (!documentRef) return
	documentRef.open()
	documentRef.write(html)
	documentRef.close()
}

function buildHeadInjection(input: {
	mode: Extract<GeneratedUiRuntimeMode, 'hosted' | 'mcp'>
	params?: Record<string, unknown>
	appSession?: AppSessionEnvelope | null
	baseHref: string | null
}) {
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		input.baseHref,
	)
	const runtimeScriptHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		input.baseHref,
	)
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: input.mode,
		params: input.params ?? {},
		...(input.appSession ? { appSession: input.appSession } : {}),
	}
	const bootstrapJson = escapeInlineScriptSource(JSON.stringify(bootstrap))
	const runtimeImportMap = buildGeneratedUiRuntimeImportMap(runtimeScriptHref)
	return `
<link rel="stylesheet" href="${stylesheetHref}" />
${runtimeImportMap}
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
</script>
<script type="module" src="${runtimeScriptHref}"></script>
	`.trim()
}

function installGeneratedUiRuntimeHooks(hooks: GeneratedUiRuntimeHooks) {
	;(globalThis.window as GeneratedUiWindow).__kodyGeneratedUiRuntimeHooks =
		hooks
}

export function shouldInitializeGeneratedUiRuntimeImmediately(input: {
	documentReadyState: Document['readyState']
	bootstrapMode: GeneratedUiRuntimeBootstrap['mode']
}) {
	return (
		input.documentReadyState !== 'loading' ||
		input.bootstrapMode === 'hosted' ||
		input.bootstrapMode === 'mcp'
	)
}

async function initializeRenderedMcpDocument(
	bootstrap: GeneratedUiRuntimeBootstrap,
) {
	let latestRenderData: RenderDataEnvelope | undefined
	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-runtime',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			latestRenderData = isRecord(renderData)
				? (renderData as RenderDataEnvelope)
				: undefined
		},
	})
	const requestDisplayMode = async (mode: DisplayMode) => {
		const displayMode = latestRenderData?.displayMode
		const availableDisplayModes = Array.isArray(
			latestRenderData?.availableDisplayModes,
		)
			? latestRenderData.availableDisplayModes
			: []
		const nextMode =
			mode === 'fullscreen' && displayMode === 'fullscreen' ? 'inline' : mode
		if (!availableDisplayModes.includes(nextMode)) {
			return null
		}
		return (await hostBridge.requestDisplayMode(nextMode)) ?? null
	}
	installGeneratedUiRuntimeHooks({
		sendMessage: (text) => hostBridge.sendUserMessageWithFallback(text),
		openLink: (url) => hostBridge.openLink(url),
		requestDisplayMode,
		executeCode: async (code) => {
			const viaHttp = await executeCodeWithHttp(bootstrap.appSession, code)
			if (viaHttp.handled) {
				return viaHttp.result
			}
			return await executeCodeWithHostTool(hostBridge, code)
		},
	})
	initializeGeneratedUiRuntime()
	globalThis.window.addEventListener('message', (event: MessageEvent) => {
		hostBridge.handleHostMessage(event.data)
	})
	void hostBridge.initialize()
	hostBridge.requestRenderData()
	void observeRenderedDocumentSize(hostBridge)
}

async function initializeShellHostDocument() {
	const baseHref = getBaseHref()
	let latestRenderData: RenderDataEnvelope | undefined
	let latestEnvelope: RenderEnvelope | null = null

	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-runtime',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			const nextRenderData = isRecord(renderData)
				? (renderData as RenderDataEnvelope)
				: undefined
			latestRenderData = nextRenderData
			void renderEnvelope(getEnvelopeFromRenderData(nextRenderData))
		},
	})

	const resolveSavedAppCode = async (
		appId: string,
		appSession: AppSessionEnvelope | null | undefined,
	): Promise<{ code: string; runtime: AppRuntime }> => {
		const hostToolResult = readSavedAppSourceFromHostToolResult(
			(await hostBridge.callTool({
				name: 'ui_load_app_source',
				arguments: {
					app_id: appId,
				},
				timeoutMs: 90_000,
			})) as HostToolResult | null,
		)
		if (hostToolResult.handled && 'code' in hostToolResult) {
			return {
				code: hostToolResult.code,
				runtime: hostToolResult.runtime,
			}
		}
		const target = appSession?.token
			? (() => {
					const url = new URL(appSession.endpoints.source)
					if (!url.searchParams.has('app_id')) {
						url.searchParams.set('app_id', appId)
					}
					return {
						url: url.toString(),
						token: appSession.token,
					}
				})()
			: (() => {
					const url = buildSavedUiEndpoint(baseHref, appId, 'source')
					return url ? { url } : null
				})()
		if (!target) {
			throw new Error(
				hostToolResult.handled
					? hostToolResult.errorMessage
					: 'Failed to load saved app source.',
			)
		}
		try {
			const targetToken =
				'token' in target && typeof target.token === 'string'
					? target.token
					: undefined
			const { response, payload } = await fetchJsonResponse({
				url: target.url,
				method: 'GET',
				token: targetToken,
			})
			const app = isRecord(payload?.app) ? payload.app : null
			if (!response.ok || !payload || payload.ok !== true || !app) {
				throw new Error(
					getApiErrorMessage(payload, 'Failed to load saved app source.'),
				)
			}
			const code = typeof app.code === 'string' ? app.code : null
			if (!code) {
				throw new Error('Saved app source is missing code.')
			}
			return {
				code,
				runtime: coerceRuntime(app.runtime) ?? 'html',
			}
		} catch (error) {
			if (hostToolResult.handled) {
				throw new Error(hostToolResult.errorMessage)
			}
			throw error
		}
	}

	const renderEnvelope = async (envelope: RenderEnvelope | null) => {
		latestEnvelope = envelope
		if (!envelope) {
			return
		}

		const buildDocument = (code: string, runtime: AppRuntime) =>
			renderGeneratedUiDocument({
				code,
				runtime,
				headInjection: buildHeadInjection({
					mode: 'mcp',
					params: envelope.params,
					appSession: envelope.appSession,
					baseHref,
				}),
				baseHref,
			})

		if (envelope.mode === 'inline_code') {
			if (!envelope.code) {
				writeDocument(
					renderGeneratedUiErrorDocument(
						'The tool result did not include inline code.',
					),
				)
				return
			}
			writeDocument(buildDocument(envelope.code, envelope.runtime ?? 'html'))
			return
		}

		if (!envelope.appId) {
			writeDocument(
				renderGeneratedUiErrorDocument(
					'The tool result did not include an app_id.',
				),
			)
			return
		}

		try {
			const resolved = await resolveSavedAppCode(
				envelope.appId,
				envelope.appSession,
			)
			if (latestEnvelope !== envelope) return
			writeDocument(buildDocument(resolved.code, resolved.runtime))
		} catch (error) {
			if (latestEnvelope !== envelope) return
			const message =
				error instanceof Error ? error.message : 'Unknown app loading error.'
			writeDocument(renderGeneratedUiErrorDocument(message))
		}
	}

	globalThis.window.addEventListener('message', (event: MessageEvent) => {
		hostBridge.handleHostMessage(event.data)
	})

	void hostBridge.initialize()
	hostBridge.requestRenderData()
	void renderEnvelope(getEnvelopeFromRenderData(latestRenderData))
}

async function initializeGeneratedUiRuntimeEntry() {
	const documentRef = globalThis.document
	if (!documentRef || !globalThis.window) return
	const bootstrap = readGeneratedUiBootstrap()
	if (bootstrap.mode === 'entry') {
		await initializeShellHostDocument()
		return
	}
	if (bootstrap.mode === 'mcp') {
		await initializeRenderedMcpDocument(bootstrap)
		return
	}
	initializeGeneratedUiRuntime()
}

const documentRef = globalThis.document

if (documentRef) {
	const bootstrap = readGeneratedUiBootstrap()
	if (
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: documentRef.readyState,
			bootstrapMode: bootstrap.mode,
		})
	) {
		void initializeGeneratedUiRuntimeEntry()
	} else {
		documentRef.addEventListener(
			'DOMContentLoaded',
			() => {
				void initializeGeneratedUiRuntimeEntry()
			},
			{ once: true },
		)
	}
}
