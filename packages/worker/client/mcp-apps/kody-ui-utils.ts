/// <reference lib="dom" />
import './kody-ui-utils.css'
import { createWidgetHostBridge } from './widget-host-bridge.js'
import {
	initializeGeneratedUiRuntime,
	setGeneratedUiRuntimeHooks,
	updateGeneratedUiRuntimeBootstrap,
} from './kody-widget-runtime.ts'
import {
	buildGeneratedUiRuntimeImportMap,
	type GeneratedUiRuntimeBootstrap,
} from './kody-ui-utils-contract.ts'
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
} from './kody-ui-utils-contract.ts'
export { kodyWidget, type KodyWidgetPublicApi } from './kody-widget-runtime.ts'

type RenderMode = 'inline_code' | 'saved_app'
type AppRuntime = 'html' | 'javascript'
type DisplayMode = 'inline' | 'fullscreen' | 'pip'

type AppSessionEnvelope = {
	sessionId?: string
	expiresAt?: string
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

type ShellScriptExecutionMode =
	| 'module'
	| 'native-classic'
	| 'isolated-classic'
	| 'ignore'
	| 'data'

type ShellScriptDescriptor = {
	target: 'head' | 'body'
	executionMode: ShellScriptExecutionMode
	attributes: Array<{ name: string; value: string }>
	src: string | null
	textContent: string
}

type ParsedShellRenderDocument = {
	title: string | null
	htmlAttributes: Array<{ name: string; value: string }>
	bodyAttributes: Array<{ name: string; value: string }>
	headNodes: Array<Node>
	bodyNodes: Array<Node>
	scripts: Array<ShellScriptDescriptor>
}

type GeneratedUiShellRenderState = {
	headSlot: HTMLElement
	bodySlot: HTMLElement
	mountedHeadNodes: Array<Node>
	managedHtmlAttributes: Set<string>
	managedBodyAttributes: Set<string>
	defaultTitle: string
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
	const endpoints = coerceGeneratedUiEndpoints(value.endpoints)
	if (!endpoints) {
		return null
	}
	return {
		sessionId:
			typeof value.sessionId === 'string' ? value.sessionId : undefined,
		expiresAt:
			typeof value.expiresAt === 'string' ? value.expiresAt : undefined,
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
	params?: Record<string, unknown>,
) {
	const result = (await hostBridge.callTool({
		name: 'execute',
		arguments: {
			code,
			...(params ? { params } : {}),
		},
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
	executeCode?: (
		code: string,
		params?: Record<string, unknown>,
	) => unknown | Promise<unknown>
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
	params?: Record<string, unknown>,
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
		body: {
			code,
			...(params ? { params } : {}),
		},
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

const generatedUiUserHeadSlotSelector =
	'[data-generated-ui-user-head-slot="true"]'
const generatedUiBodySlotSelector = '[data-generated-ui-body-slot="true"]'

function ensureGeneratedUiShellRenderState(): GeneratedUiShellRenderState | null {
	const documentRef = globalThis.document
	if (!documentRef?.head || !documentRef.body) {
		return null
	}
	const existingHeadSlot = documentRef.head.querySelector(
		generatedUiUserHeadSlotSelector,
	)
	let headSlot: HTMLElement
	if (existingHeadSlot instanceof HTMLElement) {
		headSlot = existingHeadSlot
	} else {
		headSlot = documentRef.createElement('meta')
		headSlot.setAttribute('data-generated-ui-user-head-slot', 'true')
		documentRef.head.appendChild(headSlot)
	}
	const existingBodySlot = documentRef.body.querySelector(
		generatedUiBodySlotSelector,
	)
	let bodySlot: HTMLElement
	if (existingBodySlot instanceof HTMLElement) {
		bodySlot = existingBodySlot
	} else {
		bodySlot = documentRef.createElement('div')
		bodySlot.setAttribute('id', 'app')
		bodySlot.setAttribute('data-generated-ui-root', '')
		bodySlot.setAttribute('data-generated-ui-body-slot', 'true')
		documentRef.body.insertBefore(bodySlot, documentRef.body.firstChild)
	}
	return {
		headSlot,
		bodySlot,
		mountedHeadNodes: [],
		managedHtmlAttributes: new Set<string>(),
		managedBodyAttributes: new Set<string>(),
		defaultTitle: documentRef.title,
	}
}

function clearGeneratedUiShellHead(state: GeneratedUiShellRenderState) {
	for (const node of state.mountedHeadNodes) {
		node.parentNode?.removeChild(node)
	}
	state.mountedHeadNodes = []
}

function setManagedElementAttributes(
	element: HTMLElement,
	nextAttributes: Array<{ name: string; value: string }>,
	managedAttributes: Set<string>,
) {
	for (const name of managedAttributes) {
		element.removeAttribute(name)
	}
	managedAttributes.clear()
	for (const attribute of nextAttributes) {
		element.setAttribute(attribute.name, attribute.value)
		managedAttributes.add(attribute.name)
	}
}

function mountGeneratedUiShellHeadNodes(
	state: GeneratedUiShellRenderState,
	nodes: Array<Node>,
) {
	const documentRef = globalThis.document
	if (!documentRef) return
	const parentNode = state.headSlot.parentNode
	if (!parentNode) return
	for (const node of nodes) {
		const clone = documentRef.importNode(node, true)
		parentNode.insertBefore(clone, state.headSlot)
		state.mountedHeadNodes.push(clone)
	}
}

function mountGeneratedUiShellBodyNodes(
	state: GeneratedUiShellRenderState,
	nodes: Array<Node>,
) {
	const documentRef = globalThis.document
	if (!documentRef) return
	state.bodySlot.replaceChildren(
		...nodes.map((node) => documentRef.importNode(node, true)),
	)
}

function preserveGeneratedUiHeadNode(node: Node) {
	if (node instanceof HTMLTitleElement) return false
	if (node instanceof HTMLBaseElement) return false
	if (node instanceof HTMLMetaElement) {
		return !node.hasAttribute('charset') && node.httpEquiv.length === 0
	}
	if (node.nodeType === Node.TEXT_NODE) {
		return (node.textContent ?? '').trim().length > 0
	}
	return true
}

function isClassicJavascriptScriptType(type: string) {
	return (
		type === '' ||
		type === 'application/ecmascript' ||
		type === 'application/javascript' ||
		type === 'text/ecmascript' ||
		type === 'text/javascript'
	)
}

function getShellScriptExecutionMode(script: HTMLScriptElement) {
	const normalizedType = script.type.trim().toLowerCase()
	if (normalizedType === 'importmap' || normalizedType === 'speculationrules') {
		return 'ignore' as const
	}
	if (normalizedType === 'module') {
		return 'module' as const
	}
	if (!isClassicJavascriptScriptType(normalizedType)) {
		return 'data' as const
	}
	return script.src
		? ('native-classic' as const)
		: ('isolated-classic' as const)
}

function collectElementAttributes(element: Element) {
	return Array.from(element.attributes, (attribute) => ({
		name: attribute.name,
		value: attribute.value,
	}))
}

function classifyGeneratedUiShellRenderDocument(input: {
	documentRef: Document
	preserveDocumentChrome: boolean
}) {
	const parsed: ParsedShellRenderDocument = {
		title: input.preserveDocumentChrome
			? input.documentRef.title || null
			: null,
		htmlAttributes: input.preserveDocumentChrome
			? collectElementAttributes(input.documentRef.documentElement)
			: [],
		bodyAttributes: input.preserveDocumentChrome
			? collectElementAttributes(input.documentRef.body)
			: [],
		headNodes: [],
		bodyNodes: [],
		scripts: [],
	}

	for (const node of Array.from(input.documentRef.head.childNodes)) {
		if (node instanceof HTMLScriptElement) {
			const executionMode = getShellScriptExecutionMode(node)
			if (executionMode === 'data') {
				if (preserveGeneratedUiHeadNode(node)) {
					parsed.headNodes.push(node)
				}
				continue
			}
			if (executionMode === 'ignore') {
				continue
			}
			parsed.scripts.push({
				target: 'head',
				executionMode,
				attributes: collectElementAttributes(node),
				src: node.src || null,
				textContent: node.textContent ?? '',
			})
			continue
		}
		if (preserveGeneratedUiHeadNode(node)) {
			parsed.headNodes.push(node)
		}
	}

	for (const node of Array.from(input.documentRef.body.childNodes)) {
		if (node instanceof HTMLScriptElement) {
			const executionMode = getShellScriptExecutionMode(node)
			if (executionMode === 'data') {
				parsed.bodyNodes.push(node)
				continue
			}
			if (executionMode === 'ignore') {
				continue
			}
			parsed.scripts.push({
				target: 'body',
				executionMode,
				attributes: collectElementAttributes(node),
				src: node.src || null,
				textContent: node.textContent ?? '',
			})
			continue
		}
		parsed.bodyNodes.push(node)
	}

	return parsed
}

function wrapInlineClassicScriptForIsolation(source: string) {
	return [';(function () {', source, '}).call(window);'].join('\n')
}

async function executeGeneratedUiShellScript(
	state: GeneratedUiShellRenderState,
	scriptDescriptor: ShellScriptDescriptor,
) {
	const documentRef = globalThis.document
	if (!documentRef) return
	const script = documentRef.createElement('script')
	const insertScript = () => {
		if (scriptDescriptor.target === 'head') {
			state.headSlot.parentNode?.insertBefore(script, state.headSlot)
			state.mountedHeadNodes.push(script)
			return
		}
		state.bodySlot.appendChild(script)
	}
	for (const attribute of scriptDescriptor.attributes) {
		if (attribute.name === 'src' || attribute.name === 'type') {
			continue
		}
		script.setAttribute(attribute.name, attribute.value)
	}
	if (scriptDescriptor.executionMode === 'module') {
		script.type = 'module'
	}
	if (scriptDescriptor.executionMode === 'isolated-classic') {
		script.textContent = wrapInlineClassicScriptForIsolation(
			scriptDescriptor.textContent,
		)
		insertScript()
		return
	}
	const shouldAwaitLoad =
		scriptDescriptor.executionMode === 'module' ||
		scriptDescriptor.src != null
	if (!scriptDescriptor.src) {
		script.textContent = scriptDescriptor.textContent
		if (!shouldAwaitLoad) {
			insertScript()
			return
		}
	}
	const loading = new Promise<void>((resolve, reject) => {
		script.addEventListener('load', () => resolve(), { once: true })
		script.addEventListener(
			'error',
			() => {
				reject(new Error(`Failed to load generated UI script: ${script.src}`))
			},
			{ once: true },
		)
	})
	if (scriptDescriptor.executionMode === 'native-classic') {
		script.async = false
	}
	if (scriptDescriptor.src) {
		script.src = scriptDescriptor.src
	}
	insertScript()
	await loading
}

function buildGeneratedUiShellRenderSource(input: {
	code: string
	runtime: AppRuntime
	baseHref: string | null
}) {
	return {
		htmlSource: renderGeneratedUiDocument({
			code: input.code,
			runtime: input.runtime,
			headInjection: '',
			baseHref: input.baseHref,
		}),
		preserveDocumentChrome:
			input.runtime === 'html' &&
			/<(?:!doctype|html|head|body)\b/i.test(input.code),
	}
}

async function renderGeneratedUiShellDocument(input: {
	state: GeneratedUiShellRenderState
	htmlSource: string
	preserveDocumentChrome: boolean
}) {
	const documentRef = globalThis.document
	if (!documentRef) return
	const parsedDocument = new DOMParser().parseFromString(
		input.htmlSource,
		'text/html',
	)
	const classifiedDocument = classifyGeneratedUiShellRenderDocument({
		documentRef: parsedDocument,
		preserveDocumentChrome: input.preserveDocumentChrome,
	})
	clearGeneratedUiShellHead(input.state)
	input.state.bodySlot.replaceChildren()
	setManagedElementAttributes(
		documentRef.documentElement,
		classifiedDocument.htmlAttributes,
		input.state.managedHtmlAttributes,
	)
	setManagedElementAttributes(
		documentRef.body,
		classifiedDocument.bodyAttributes,
		input.state.managedBodyAttributes,
	)
	documentRef.title = classifiedDocument.title ?? input.state.defaultTitle
	mountGeneratedUiShellHeadNodes(input.state, classifiedDocument.headNodes)
	mountGeneratedUiShellBodyNodes(input.state, classifiedDocument.bodyNodes)
	for (const scriptDescriptor of classifiedDocument.scripts) {
		await executeGeneratedUiShellScript(input.state, scriptDescriptor)
	}
}

export type BuildGeneratedUiHeadInjectionInput = {
	mode: Extract<GeneratedUiRuntimeMode, 'hosted' | 'mcp'>
	params?: Record<string, unknown>
	appSession?: AppSessionEnvelope | null
	baseHref: string | null
	/**
	 * When false, omit the runtime module script. Use when the generated UI shell
	 * has already loaded `kody-ui-utils.js` — a second `<script type="module">` for
	 * the same URL does not re-run the module, so hooks/init must be triggered
	 * from the shell instead.
	 */
	includeRuntimeScript?: boolean
}

export function buildGeneratedUiRuntimeHeadInjection(
	input: BuildGeneratedUiHeadInjectionInput,
) {
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
	const includeRuntimeScript = input.includeRuntimeScript !== false
	const runtimeScriptTag = includeRuntimeScript
		? `\n<script type="module" src="${runtimeScriptHref}"></script>`
		: ''
	return `
<link rel="stylesheet" href="${stylesheetHref}" />
${runtimeImportMap}
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
</script>${runtimeScriptTag}
	`.trim()
}

function installGeneratedUiRuntimeHooks(hooks: GeneratedUiRuntimeHooks) {
	setGeneratedUiRuntimeHooks(hooks)
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

function activateMcpGeneratedUiRuntime(
	hostBridge: ReturnType<typeof createWidgetHostBridge>,
	bootstrap: GeneratedUiRuntimeBootstrap,
	latestRenderDataRef: { current: RenderDataEnvelope | undefined },
) {
	const requestDisplayMode = async (mode: DisplayMode) => {
		const displayMode = latestRenderDataRef.current?.displayMode
		const availableDisplayModes = Array.isArray(
			latestRenderDataRef.current?.availableDisplayModes,
		)
			? latestRenderDataRef.current.availableDisplayModes
			: []
		const nextMode =
			mode === 'fullscreen' && displayMode === 'fullscreen' ? 'inline' : mode
		if (!availableDisplayModes.includes(nextMode)) {
			return null
		}
		return (await hostBridge.requestDisplayMode(nextMode)) ?? null
	}
	updateGeneratedUiRuntimeBootstrap(bootstrap)
	installGeneratedUiRuntimeHooks({
		sendMessage: (text) => hostBridge.sendUserMessageWithFallback(text),
		openLink: (url) => hostBridge.openLink(url),
		requestDisplayMode,
		executeCode: async (code, params) => {
			const { appSession } = readGeneratedUiBootstrap()
			const viaHttp = await executeCodeWithHttp(appSession, code, params)
			if (viaHttp.handled) {
				return viaHttp.result
			}
			return await executeCodeWithHostTool(hostBridge, code, params)
		},
	})
	initializeGeneratedUiRuntime()
	void observeRenderedDocumentSize(hostBridge)
}

async function initializeRenderedMcpDocument(
	bootstrap: GeneratedUiRuntimeBootstrap,
) {
	let latestRenderData: RenderDataEnvelope | undefined
	const latestRenderDataRef = {
		get current() {
			return latestRenderData
		},
	}
	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'kody-ui-utils',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			latestRenderData = isRecord(renderData)
				? (renderData as RenderDataEnvelope)
				: undefined
		},
	})
	activateMcpGeneratedUiRuntime(hostBridge, bootstrap, latestRenderDataRef)
	globalThis.window.addEventListener('message', (event: MessageEvent) => {
		hostBridge.handleHostMessage(event.data)
	})
	void hostBridge.initialize()
	hostBridge.requestRenderData()
}

async function initializeShellHostDocument() {
	const baseHref = getBaseHref()
	let latestRenderData: RenderDataEnvelope | undefined
	const latestRenderDataRef = {
		get current() {
			return latestRenderData
		},
	}
	const shellRenderState = ensureGeneratedUiShellRenderState()
	let renderQueue: Promise<void> = Promise.resolve()
	let latestScheduledRenderId = 0

	const scheduleRenderEnvelope = (envelope: RenderEnvelope | null) => {
		const renderId = ++latestScheduledRenderId
		renderQueue = renderQueue
			.catch(() => undefined)
			.then(() => renderEnvelope(envelope, renderId))
			.catch(() => undefined)
	}

	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'kody-ui-utils',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			const nextRenderData = isRecord(renderData)
				? (renderData as RenderDataEnvelope)
				: undefined
			latestRenderData = nextRenderData
			scheduleRenderEnvelope(getEnvelopeFromRenderData(nextRenderData))
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

	const isStaleRender = (renderId: number) => renderId !== latestScheduledRenderId

	async function renderEnvelope(
		envelope: RenderEnvelope | null,
		renderId: number,
	) {
		if (isStaleRender(renderId)) {
			return
		}
		if (!envelope) {
			return
		}

		const mcpRuntimeBootstrap: GeneratedUiRuntimeBootstrap = {
			mode: 'mcp',
			params: envelope.params ?? {},
			...(envelope.appSession ? { appSession: envelope.appSession } : {}),
		}
		updateGeneratedUiRuntimeBootstrap(mcpRuntimeBootstrap)

		const renderCode = async (code: string, runtime: AppRuntime) => {
			if (!shellRenderState) {
				return
			}
			const renderSource = buildGeneratedUiShellRenderSource({
				code,
				runtime,
				baseHref,
			})
			await renderGeneratedUiShellDocument({
				state: shellRenderState,
				htmlSource: renderSource.htmlSource,
				preserveDocumentChrome: renderSource.preserveDocumentChrome,
			})
		}

		const renderError = async (message: string) => {
			if (!shellRenderState) {
				return
			}
			await renderGeneratedUiShellDocument({
				state: shellRenderState,
				htmlSource: renderGeneratedUiErrorDocument(message),
				preserveDocumentChrome: true,
			})
		}

		if (envelope.mode === 'inline_code') {
			if (!envelope.code) {
				await renderError('The tool result did not include inline code.')
				return
			}
			await renderCode(envelope.code, envelope.runtime ?? 'html')
			return
		}

		if (!envelope.appId) {
			await renderError('The tool result did not include an app_id.')
			return
		}

		try {
			if (isStaleRender(renderId)) {
				return
			}
			const resolved = await resolveSavedAppCode(
				envelope.appId,
				envelope.appSession,
			)
			if (isStaleRender(renderId)) return
			await renderCode(resolved.code, resolved.runtime)
		} catch (error) {
			if (isStaleRender(renderId)) return
			const message =
				error instanceof Error ? error.message : 'Unknown app loading error.'
			await renderError(message)
		}
	}

	globalThis.window.addEventListener('message', (event: MessageEvent) => {
		hostBridge.handleHostMessage(event.data)
	})

	activateMcpGeneratedUiRuntime(
		hostBridge,
		{
			mode: 'mcp',
			params: {},
		},
		latestRenderDataRef,
	)
	void hostBridge.initialize()
	hostBridge.requestRenderData()
	scheduleRenderEnvelope(getEnvelopeFromRenderData(latestRenderData))
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

function startGeneratedUiRuntimeEntry() {
	const documentRef = globalThis.document
	if (!documentRef) return
	const bootstrap = readGeneratedUiBootstrap()
	const run = () => {
		void initializeGeneratedUiRuntimeEntry()
	}
	if (
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: documentRef.readyState,
			bootstrapMode: bootstrap.mode,
		})
	) {
		run()
		return
	}
	documentRef.addEventListener('DOMContentLoaded', run, { once: true })
}

startGeneratedUiRuntimeEntry()
