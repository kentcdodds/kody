/// <reference lib="dom" />
import {
	type GeneratedUiAppSessionBootstrap,
	type GeneratedUiRuntimeBootstrap,
	type GeneratedUiSecretMetadata,
	type GeneratedUiStorageScope,
	type GeneratedUiValueMetadata,
} from './kody-ui-utils-contract.ts'

type DisplayMode = 'inline' | 'fullscreen' | 'pip'
type JsonRecord = Record<string, any>
type FormObject = Record<string, string | Array<string> | null>
type FormReference = string | HTMLFormElement
type SessionEndpoints = GeneratedUiAppSessionBootstrap['endpoints']
type WidgetRuntimeBootstrap = {
	mode: GeneratedUiRuntimeBootstrap['mode']
	params: JsonRecord
	appSession: GeneratedUiAppSessionBootstrap | null
}
type SaveSecretInput = {
	name: string
	value: string
	description?: string
	scope?: GeneratedUiStorageScope
}
type SaveSecretResult =
	| { ok: true; secret?: GeneratedUiSecretMetadata }
	| { ok: false; error: string }
type DeleteSecretInput = {
	name: string
	scope?: GeneratedUiStorageScope
}
type DeleteSecretResult =
	| { ok: true; deleted: boolean }
	| { ok: false; error: string }
type SaveValueInput = {
	name: string
	value: string
	description?: string
	scope?: GeneratedUiStorageScope
}
type SaveValueResult =
	| { ok: true; value: GeneratedUiValueMetadata }
	| { ok: false; error: string }
type SaveSecretsResult = {
	ok: boolean
	results: Array<{
		name: string
		ok: boolean
		secret?: GeneratedUiSecretMetadata
		error?: string
	}>
}
type SaveValuesResult = {
	ok: boolean
	results: Array<{
		name: string
		ok: boolean
		value?: GeneratedUiValueMetadata
		error?: string
	}>
}
type NormalizedFetchWithSecretsInput =
	| {
			ok: true
			value: {
				url: string
				method: string
				headers: Record<string, string>
				body?: string
			}
	  }
	| {
			ok: false
			error: string
	  }
type NormalizedFetchWithSecretsResult =
	| {
			ok: true
			status: number
			headers: Record<string, string>
			data: unknown
			text: string | null
	  }
	| {
			ok: false
			kind: 'http_error' | 'execution_error'
			message?: string
			status?: number
			headers?: Record<string, string>
			data?: unknown
			text?: string | null
	  }
type ApprovalDetails = {
	message: string
	approvalUrl: string | null
	host: string | null
	secretNames: Array<string>
}
type OAuthFetchResult = {
	ok: boolean
	status: number
	headers: Record<string, string>
	data: unknown
	text: string | null
}
type PersistFormOptions = {
	storageKey: string
	fields?: Array<string>
}
type BuildSecretFormField = {
	inputName: string
	secretName: string
	description?: string
	scope?: GeneratedUiStorageScope
}
type BuildSecretFormInput = {
	form: FormReference
	fields: Array<BuildSecretFormField>
	onSuccess?: (result: SaveSecretsResult, values: FormObject) => unknown
	onError?: (result: SaveSecretsResult, values: FormObject) => unknown
}
type MessageLogRefs = {
	root: HTMLElement
	list: HTMLElement
}

export type KodyWidgetPublicApi = Record<string, unknown> & {
	params: JsonRecord
	executeCode: (code: string, params?: JsonRecord) => Promise<unknown>
}

type KodyWidgetReadyState = {
	promise: Promise<KodyWidgetPublicApi>
	resolve: (widget: KodyWidgetPublicApi) => void
}

type KodyWindow = Window &
	typeof globalThis & {
		__kodyGeneratedUiBootstrap?: GeneratedUiRuntimeBootstrap
		__kodyAppParams?: Record<string, unknown>
		__kodyGeneratedUiRuntimeInitialized?: boolean
		__kodyGeneratedUiRuntimeHooks?: {
			sendMessage?: (text: string) => boolean | Promise<boolean>
			openLink?: (url: string) => boolean | Promise<boolean>
			requestDisplayMode?: (
				mode: DisplayMode,
			) => DisplayMode | null | Promise<DisplayMode | null>
			executeCode?: (
				code: string,
				params?: JsonRecord,
			) => unknown | Promise<unknown>
		}
		__kodyLocalMessageLogRoot?: HTMLElement | null
		__kodyLocalMessageLogList?: HTMLElement | null
		__kodyWidgetReadyState?: KodyWidgetReadyState
		kodyWidget?: KodyWidgetPublicApi
		params?: Record<string, unknown>
	}

const kodyWindow = (
	typeof window === 'object' && window ? window : globalThis
) as KodyWindow

let currentKodyWidget: KodyWidgetPublicApi | null = null
let kodyWidgetReadyState: KodyWidgetReadyState | null = null

function readKodyWidget() {
	return currentKodyWidget
}

function getOrCreateKodyWidgetReadyState(): KodyWidgetReadyState {
	const existingState = kodyWidgetReadyState
	if (existingState) {
		return existingState
	}
	let resolvePromise: ((widget: KodyWidgetPublicApi) => void) | null = null
	const state: KodyWidgetReadyState = {
		promise: new Promise<KodyWidgetPublicApi>((resolve) => {
			resolvePromise = resolve
		}),
		resolve(widget) {
			resolvePromise?.(widget)
		},
	}
	kodyWidgetReadyState = state
	return state
}

function resolveKodyWidgetReady(widget: KodyWidgetPublicApi) {
	getOrCreateKodyWidgetReadyState().resolve(widget)
}

export function getKodyWidget(): KodyWidgetPublicApi {
	const widget = readKodyWidget()
	if (widget) {
		return widget
	}
	throw new Error(
		'kodyWidget is not ready yet. Import `whenKodyWidgetReady()` from `@kody/ui-utils` and await it before using the runtime helpers.',
	)
}

export function whenKodyWidgetReady(): Promise<KodyWidgetPublicApi> {
	const widget = readKodyWidget()
	if (widget) {
		return Promise.resolve(widget)
	}
	return getOrCreateKodyWidgetReadyState().promise
}

export function getOrCreateKodyWidgetReadyStateForTest() {
	return {
		resolve(widget: KodyWidgetPublicApi) {
			currentKodyWidget = widget
			resolveKodyWidgetReady(widget)
		},
		reset() {
			currentKodyWidget = null
			kodyWidgetReadyState = null
		},
	}
}

export const kodyWidget = new Proxy(Object.create(null), {
	get(_target, property) {
		const widget = getKodyWidget()
		const value = Reflect.get(widget, property)
		return typeof value === 'function' ? value.bind(widget) : value
	},
	has(_target, property) {
		return property in getKodyWidget()
	},
	ownKeys() {
		return Reflect.ownKeys(getKodyWidget())
	},
	getOwnPropertyDescriptor(_target, property) {
		const descriptor = Reflect.getOwnPropertyDescriptor(
			getKodyWidget(),
			property,
		)
		if (!descriptor) {
			return undefined
		}
		return {
			...descriptor,
			configurable: true,
		}
	},
}) as KodyWidgetPublicApi

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceStorageScope(value: unknown): GeneratedUiStorageScope | null {
	return value === 'session' || value === 'app' || value === 'user'
		? value
		: null
}

function coerceValueMetadata(value: unknown): GeneratedUiValueMetadata | null {
	if (!isRecord(value)) return null
	const record = value
	const scope = coerceStorageScope(record.scope)
	if (
		typeof record.name !== 'string' ||
		typeof record.value !== 'string' ||
		typeof record.description !== 'string' ||
		scope == null ||
		(record.app_id != null && typeof record.app_id !== 'string') ||
		typeof record.created_at !== 'string' ||
		typeof record.updated_at !== 'string' ||
		(record.ttl_ms != null &&
			(typeof record.ttl_ms !== 'number' ||
				!Number.isFinite(record.ttl_ms) ||
				record.ttl_ms < 0))
	) {
		return null
	}

	return {
		name: record.name,
		scope,
		value: record.value,
		description: record.description,
		app_id: record.app_id ?? null,
		created_at: record.created_at,
		updated_at: record.updated_at,
		ttl_ms: record.ttl_ms ?? null,
	}
}

function coerceSecretMetadata(
	value: unknown,
): GeneratedUiSecretMetadata | null {
	if (!isRecord(value)) return null
	const record = value
	const scope = coerceStorageScope(record.scope)
	if (
		typeof record.name !== 'string' ||
		typeof record.description !== 'string' ||
		scope == null ||
		(record.app_id != null && typeof record.app_id !== 'string') ||
		!Array.isArray(record.allowed_hosts) ||
		!record.allowed_hosts.every((host) => typeof host === 'string') ||
		typeof record.created_at !== 'string' ||
		typeof record.updated_at !== 'string' ||
		(record.ttl_ms != null &&
			(typeof record.ttl_ms !== 'number' ||
				!Number.isFinite(record.ttl_ms) ||
				record.ttl_ms < 0))
	) {
		return null
	}

	return {
		name: record.name,
		scope,
		description: record.description,
		app_id: record.app_id ?? null,
		allowed_hosts: record.allowed_hosts,
		created_at: record.created_at,
		updated_at: record.updated_at,
		ttl_ms: record.ttl_ms ?? null,
	}
}

function buildCodemodeCapabilityExecuteCode(
	name: string,
	args: JsonRecord = {},
) {
	return [
		'async () => {',
		'  return await codemode[' +
			JSON.stringify(name) +
			'](' +
			JSON.stringify(args ?? {}) +
			');',
		'}',
	].join('\n')
}

function normalizeSecretNameList(values: Array<unknown>): Array<string> {
	return Array.from(
		new Set(
			values.filter((value) => typeof value === 'string' && value.length > 0),
		),
	) as Array<string>
}

function extractSecretNamesFromValue(
	value: unknown,
	collected: Array<string> = [],
): Array<string> {
	if (typeof value === 'string') {
		for (const match of value.matchAll(/\{\{secret:([a-zA-Z0-9._-]+)/g)) {
			if (match[1]) collected.push(match[1])
		}
		return collected
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			extractSecretNamesFromValue(entry, collected)
		}
		return collected
	}

	if (isRecord(value)) {
		for (const entry of Object.values(value)) {
			extractSecretNamesFromValue(entry, collected)
		}
	}

	return collected
}

function extractApprovalDetails(
	message: unknown,
	fallbackSecretNames: Array<unknown> = [],
): ApprovalDetails {
	const text = typeof message === 'string' ? message : String(message ?? '')
	const hostBatchPrefix = 'Secrets require host approval:'
	if (text.startsWith(hostBatchPrefix)) {
		const raw = text.slice(hostBatchPrefix.length).trim()
		try {
			const parsed = JSON.parse(raw)
			if (Array.isArray(parsed)) {
				const secretNames = normalizeSecretNameList([
					...parsed
						.map((entry) =>
							entry && typeof entry.secretName === 'string'
								? entry.secretName
								: null,
						)
						.filter((entry): entry is string => Boolean(entry)),
					...fallbackSecretNames,
				])
				const first = parsed.find(
					(entry) =>
						entry &&
						typeof entry.approvalUrl === 'string' &&
						typeof entry.host === 'string',
				)
				if (first) {
					return {
						message: text,
						approvalUrl: first.approvalUrl,
						host: first.host,
						secretNames,
					}
				}
				if (secretNames.length > 0) {
					return {
						message: text,
						approvalUrl: null,
						host: null,
						secretNames,
					}
				}
			}
		} catch {
			// Fall through to legacy parsing.
		}
	}
	const secretNames = normalizeSecretNameList([
		...Array.from(text.matchAll(/Secret "([^"]+)"/g))
			.map((match) => match[1])
			.filter(Boolean),
		...fallbackSecretNames,
	])
	const hostMatch = text.match(/host "([^"]+)"/)
	let approvalUrl = null
	for (const part of text.split(/\s+/)) {
		if (part.startsWith('http://') || part.startsWith('https://')) {
			approvalUrl = part.replace(/[),.;]+$/, '')
			break
		}
	}
	return {
		message: text,
		approvalUrl,
		host: hostMatch?.[1] ?? null,
		secretNames,
	}
}

function resolveFormReference(
	formRef: FormReference | null | undefined,
): HTMLFormElement | Element | null {
	if (typeof formRef === 'string') {
		return document.querySelector(formRef)
	}
	return formRef && typeof formRef === 'object' ? formRef : null
}

function formDataToObject(formData: FormData): FormObject {
	const result: FormObject = {}
	for (const name of new Set(formData.keys())) {
		const all = formData
			.getAll(name)
			.map((entry) => (typeof entry === 'string' ? entry : entry.name))
		result[name] = all.length > 1 ? all : (all[0] ?? null)
	}
	return result
}

function pickLastFormValue(value: unknown): string | null {
	if (Array.isArray(value)) {
		const lastValue = value.length > 0 ? value[value.length - 1] : null
		return typeof lastValue === 'string'
			? lastValue
			: lastValue == null
				? null
				: String(lastValue)
	}
	return typeof value === 'string'
		? value
		: value == null
			? null
			: String(value)
}

function toStringArray(value: unknown): Array<string> {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			typeof entry === 'string' ? entry : String(entry),
		)
	}
	if (value == null) return []
	return [typeof value === 'string' ? value : String(value)]
}

function setControlValues(
	form: HTMLFormElement,
	name: string,
	values: Array<string>,
) {
	const controls = Array.from(form.elements).filter((element) => {
		return (
			element &&
			typeof element === 'object' &&
			'name' in element &&
			element.name === name
		)
	})
	if (controls.length === 0) return
	for (const control of controls) {
		if (control instanceof HTMLInputElement) {
			if (control.type !== 'checkbox' && control.type !== 'radio') {
				control.value =
					values.length > 0 ? (values[values.length - 1] ?? '') : ''
				continue
			}
			const controlValue =
				typeof control.value === 'string' && control.value.length > 0
					? control.value
					: 'on'
			control.checked =
				values.includes(controlValue) ||
				(control.type === 'checkbox' &&
					controlValue === 'on' &&
					values.some(
						(value: string) =>
							value === 'true' || value === '1' || value === 'on',
					))
			continue
		}
		if (control instanceof HTMLSelectElement && control.multiple) {
			for (const option of Array.from(control.options)) {
				option.selected = values.includes(option.value)
			}
			continue
		}
		if (
			control instanceof HTMLSelectElement ||
			control instanceof HTMLTextAreaElement
		) {
			control.value = values.length > 0 ? (values[values.length - 1] ?? '') : ''
		}
	}
}

function getTopLocationUrl(inputUrl?: string) {
	if (inputUrl) {
		return new URL(inputUrl, window.location.href)
	}
	try {
		if (window.top && window.top.location && window.top.location.href) {
			return new URL(window.top.location.href)
		}
	} catch {}
	return new URL(window.location.href)
}

function normalizeFetchWithSecretsInput(
	input: unknown,
): NormalizedFetchWithSecretsInput {
	if (!isRecord(input)) {
		return { ok: false, error: 'fetchWithSecrets input must be an object.' }
	}
	if (typeof input.url !== 'string' || input.url.length === 0) {
		return { ok: false, error: 'fetchWithSecrets requires a url.' }
	}
	const headers: Record<string, string> = {}
	if (isRecord(input.headers)) {
		for (const [key, value] of Object.entries(input.headers)) {
			if (typeof value === 'string') {
				headers[key] = value
			}
		}
	}
	let body = input.body
	if (body != null && typeof body !== 'string') {
		body = JSON.stringify(body)
		const hasContentType = Object.keys(headers).some(
			(key) => key.toLowerCase() === 'content-type',
		)
		if (!hasContentType) {
			headers['Content-Type'] = 'application/json'
		}
	}
	return {
		ok: true,
		value: {
			url: input.url,
			method:
				typeof input.method === 'string' && input.method.length > 0
					? input.method.toUpperCase()
					: 'GET',
			headers,
			body: typeof body === 'string' ? body : undefined,
		},
	}
}

function buildFetchWithSecretsExecuteCode(input: {
	url: string
	method: string
	headers: Record<string, string>
	body?: string
}) {
	return [
		'async () => {',
		'  const response = await fetch(' + JSON.stringify(input.url) + ', {',
		'    method: ' + JSON.stringify(input.method) + ',',
		'    headers: ' + JSON.stringify(input.headers) + ',',
		input.body != null ? '    body: ' + JSON.stringify(input.body) + ',' : '',
		'  });',
		'  const headers = Object.fromEntries(response.headers.entries());',
		'  const contentType = response.headers.get("content-type") || "";',
		'  const text = await response.text();',
		'  let data = null;',
		'  if (/\\bjson\\b/i.test(contentType) && text) {',
		'    try {',
		'      data = JSON.parse(text);',
		'    } catch {}',
		'  }',
		'  return {',
		'    ok: response.ok,',
		'    status: response.status,',
		'    headers,',
		'    data,',
		'    text: text || null,',
		'  };',
		'}',
	]
		.filter(Boolean)
		.join('\n')
}

function normalizeFetchWithSecretsResult(
	result: unknown,
): NormalizedFetchWithSecretsResult {
	if (!isRecord(result)) {
		return {
			ok: false,
			kind: 'execution_error',
			message: 'fetchWithSecrets returned an invalid result.',
		}
	}
	const headers = isRecord(result.headers)
		? Object.fromEntries(
				Object.entries(result.headers).filter(
					(entry) => typeof entry[1] === 'string',
				),
			)
		: {}
	const status = typeof result.status === 'number' ? result.status : 0
	const text =
		typeof result.text === 'string' || result.text == null ? result.text : null
	const data = 'data' in result ? result.data : null
	if (result.ok === true) {
		return {
			ok: true,
			status,
			headers,
			data,
			text,
		}
	}
	return {
		ok: false,
		kind: 'http_error',
		status,
		headers,
		data,
		text,
	}
}

function appendOAuthExtraParams(params: URLSearchParams, extraParams: unknown) {
	if (!isRecord(extraParams)) return
	for (const [key, value] of Object.entries(extraParams)) {
		if (value == null) continue
		params.set(key, typeof value === 'string' ? value : String(value))
	}
}

async function readOAuthFetchResult(
	response: Response,
): Promise<OAuthFetchResult> {
	const headers = Object.fromEntries(response.headers.entries()) as Record<
		string,
		string
	>
	const contentType = response.headers.get('content-type') || ''
	const text = await response.text()
	let data = null
	if (/\bjson\b/i.test(contentType) && text) {
		try {
			data = JSON.parse(text)
		} catch {}
	}
	return {
		ok: response.ok,
		status: response.status,
		headers,
		data,
		text: text || null,
	}
}

function ensureLocalMessageLog(): MessageLogRefs | null {
	const doc = window.document
	if (!doc || typeof doc.createElement !== 'function') return null
	const host = doc.body || doc.documentElement
	if (!host) return null
	const existingRoot = kodyWindow.__kodyLocalMessageLogRoot
	const existingList = kodyWindow.__kodyLocalMessageLogList
	if (existingRoot && existingList && existingRoot.parentNode) {
		return { root: existingRoot, list: existingList }
	}
	const root = doc.createElement('section')
	root.setAttribute('data-kody-local-message-log', 'true')
	root.setAttribute('role', 'log')
	root.setAttribute('aria-live', 'polite')
	root.style.cssText = [
		'position:fixed',
		'left:12px',
		'right:12px',
		'bottom:calc(env(safe-area-inset-bottom, 0px) + 12px)',
		'z-index:2147483647',
		'display:flex',
		'flex-direction:column',
		'gap:8px',
		'max-height:min(40vh, 320px)',
		'padding:12px',
		'overflow:auto',
		'border-radius:16px',
		'background:rgba(15, 23, 42, 0.92)',
		'color:#f8fafc',
		'box-shadow:0 16px 40px rgba(15, 23, 42, 0.28)',
		'font:500 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
		'box-sizing:border-box',
		'backdrop-filter:blur(16px)',
		'-webkit-backdrop-filter:blur(16px)',
	].join(';')
	const title = doc.createElement('div')
	title.textContent = 'Messages'
	title.style.cssText = [
		'font-size:12px',
		'font-weight:700',
		'letter-spacing:0.08em',
		'text-transform:uppercase',
		'color:rgba(226, 232, 240, 0.8)',
	].join(';')
	const list = doc.createElement('div')
	list.style.cssText = [
		'display:flex',
		'flex-direction:column',
		'gap:8px',
	].join(';')
	root.appendChild(title)
	root.appendChild(list)
	host.appendChild(root)
	kodyWindow.__kodyLocalMessageLogRoot = root
	kodyWindow.__kodyLocalMessageLogList = list
	return { root, list }
}

function formatLocalMessageTimestamp(date: Date) {
	try {
		return new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit',
		}).format(date)
	} catch {
		return date.toLocaleTimeString()
	}
}

function appendLocalMessageLogEntry(text: unknown) {
	const refs = ensureLocalMessageLog()
	if (!refs) return false
	const doc = window.document
	const entry = doc.createElement('div')
	entry.style.cssText = [
		'padding:10px 12px',
		'border-radius:12px',
		'background:rgba(148, 163, 184, 0.18)',
		'border:1px solid rgba(148, 163, 184, 0.2)',
		'box-shadow:inset 0 1px 0 rgba(255,255,255,0.04)',
	].join(';')
	const timestamp = doc.createElement('div')
	timestamp.textContent = formatLocalMessageTimestamp(new Date())
	timestamp.style.cssText = [
		'margin-bottom:4px',
		'font-size:11px',
		'font-weight:700',
		'letter-spacing:0.02em',
		'color:rgba(226, 232, 240, 0.72)',
	].join(';')
	const body = doc.createElement('div')
	body.textContent = typeof text === 'string' ? text : String(text ?? '')
	body.style.cssText = ['white-space:pre-wrap', 'word-break:break-word'].join(
		';',
	)
	entry.appendChild(timestamp)
	entry.appendChild(body)
	refs.list.appendChild(entry)
	refs.list.scrollTop = refs.list.scrollHeight
	return true
}

function coerceSessionEndpoints(value: unknown): SessionEndpoints | null {
	if (!isRecord(value)) return null
	if (
		typeof value.source !== 'string' ||
		typeof value.execute !== 'string' ||
		typeof value.secrets !== 'string' ||
		typeof value.deleteSecret !== 'string'
	) {
		return null
	}
	return {
		source: value.source,
		execute: value.execute,
		secrets: value.secrets,
		deleteSecret: value.deleteSecret,
	}
}

function getBootstrap(): WidgetRuntimeBootstrap {
	if (!isRecord(kodyWindow.__kodyGeneratedUiBootstrap)) {
		return {
			mode: 'entry',
			params: {},
			appSession: null,
		}
	}
	const params = isRecord(kodyWindow.__kodyGeneratedUiBootstrap.params)
		? kodyWindow.__kodyGeneratedUiBootstrap.params
		: {}
	const appSession = isRecord(kodyWindow.__kodyGeneratedUiBootstrap.appSession)
		? {
				token:
					typeof kodyWindow.__kodyGeneratedUiBootstrap.appSession.token ===
					'string'
						? kodyWindow.__kodyGeneratedUiBootstrap.appSession.token
						: undefined,
				endpoints: coerceSessionEndpoints(
					kodyWindow.__kodyGeneratedUiBootstrap.appSession.endpoints,
				),
			}
		: null
	return {
		mode:
			kodyWindow.__kodyGeneratedUiBootstrap.mode === 'entry' ||
			kodyWindow.__kodyGeneratedUiBootstrap.mode === 'hosted' ||
			kodyWindow.__kodyGeneratedUiBootstrap.mode === 'mcp'
				? kodyWindow.__kodyGeneratedUiBootstrap.mode
				: 'entry',
		params,
		appSession:
			appSession && appSession.endpoints
				? {
						token: appSession.token,
						endpoints: appSession.endpoints,
					}
				: null,
	}
}

export function initializeGeneratedUiRuntime() {
	if (kodyWindow.__kodyGeneratedUiRuntimeInitialized) {
		return
	}
	const bootstrap = getBootstrap()
	if (bootstrap.mode === 'entry') {
		return
	}
	kodyWindow.__kodyGeneratedUiRuntimeInitialized = true
	const runtimeMode: Exclude<GeneratedUiRuntimeBootstrap['mode'], 'entry'> =
		bootstrap.mode
	const runtimeParams = bootstrap.params
	const sessionToken =
		bootstrap.appSession && typeof bootstrap.appSession.token === 'string'
			? bootstrap.appSession.token
			: null
	const sessionEndpoints = bootstrap.appSession?.endpoints ?? null

	function getApiErrorMessage(payload: JsonRecord | null, fallback: string) {
		return typeof payload?.error === 'string' ? payload.error : fallback
	}

	function getRuntimeHooks(): NonNullable<
		KodyWindow['__kodyGeneratedUiRuntimeHooks']
	> {
		return isRecord(kodyWindow.__kodyGeneratedUiRuntimeHooks)
			? kodyWindow.__kodyGeneratedUiRuntimeHooks
			: {}
	}

	function getSessionRequestTarget(
		type: 'execute' | 'secrets' | 'delete-secret',
	) {
		if (!sessionToken || !sessionEndpoints) {
			return null
		}
		const url =
			type === 'execute'
				? sessionEndpoints.execute
				: type === 'secrets'
					? sessionEndpoints.secrets
					: sessionEndpoints.deleteSecret
		if (typeof url !== 'string' || url.length === 0) {
			return null
		}
		return { url, token: sessionToken }
	}

	async function fetchJsonResponse(input: {
		url: string
		method?: 'GET' | 'POST'
		body?: JsonRecord
		token?: string
	}): Promise<{ response: Response; payload: JsonRecord | null }> {
		const headers = new Headers({
			Accept: 'application/json',
		})
		if (input.body) {
			headers.set('Content-Type', 'application/json')
		}
		if (input.token) {
			headers.set('Authorization', 'Bearer ' + input.token)
		}
		const response = await fetch(input.url, {
			method: input.method ?? 'GET',
			headers,
			body: input.body ? JSON.stringify(input.body) : undefined,
			cache: 'no-store',
			credentials: input.token ? 'omit' : 'include',
		})
		const payload = (await response
			.json()
			.catch(() => null)) as JsonRecord | null
		return { response, payload }
	}

	async function executeCodeWithHttp(code: string, params?: JsonRecord) {
		const target = getSessionRequestTarget('execute')
		if (!target) {
			throw new Error('Code execution is unavailable in this context.')
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
		return payload.result ?? null
	}

	async function saveSecretWithHttp(
		input: SaveSecretInput,
	): Promise<SaveSecretResult> {
		const target = getSessionRequestTarget('secrets')
		if (!target) {
			return {
				ok: false,
				error: 'Secret storage is unavailable in this context.',
			}
		}
		const { response, payload } = await fetchJsonResponse({
			url: target.url,
			method: 'POST',
			body: {
				name: input.name,
				value: input.value,
				description: input.description ?? '',
				...(input.scope ? { scope: input.scope } : {}),
			},
			token: target.token,
		})
		if (!response.ok || !payload || payload.ok !== true) {
			return {
				ok: false,
				error: getApiErrorMessage(payload, 'Unable to save secret.'),
			}
		}
		return {
			ok: true,
			secret: coerceSecretMetadata(payload.secret) ?? undefined,
		}
	}

	async function listSecretsWithHttp(
		scope?: GeneratedUiStorageScope,
	): Promise<Array<GeneratedUiSecretMetadata>> {
		const target = getSessionRequestTarget('secrets')
		if (!target) return []
		const url = new URL(target.url)
		if (scope) {
			url.searchParams.set('scope', scope)
		}
		const { response, payload } = await fetchJsonResponse({
			url: url.toString(),
			method: 'GET',
			token: target.token,
		})
		if (!response.ok || !Array.isArray(payload?.secrets)) {
			throw new Error(getApiErrorMessage(payload, 'Unable to list secrets.'))
		}
		return payload.secrets
			.map((secret: unknown) => coerceSecretMetadata(secret))
			.filter((secret: GeneratedUiSecretMetadata | null) => secret != null)
	}

	async function deleteSecretWithHttp(
		input: DeleteSecretInput,
	): Promise<DeleteSecretResult> {
		const target = getSessionRequestTarget('delete-secret')
		if (!target) {
			return {
				ok: false,
				error: 'Secret storage is unavailable in this context.',
			}
		}
		const { response, payload } = await fetchJsonResponse({
			url: target.url,
			method: 'POST',
			body: {
				name: input.name,
				...(input.scope ? { scope: input.scope } : {}),
			},
			token: target.token,
		})
		if (!response.ok || !payload || payload.ok !== true) {
			return {
				ok: false,
				error: getApiErrorMessage(payload, 'Unable to delete secret.'),
			}
		}
		return {
			ok: true,
			deleted: payload.deleted === true,
		}
	}

	function getOAuthStorage(): Storage {
		try {
			return window.localStorage
		} catch {
			return window.sessionStorage
		}
	}

	async function requestDisplayMode(
		mode: DisplayMode,
	): Promise<DisplayMode | null> {
		if (runtimeMode === 'mcp') {
			const hook = getRuntimeHooks().requestDisplayMode
			return typeof hook === 'function' ? await hook(mode) : null
		}
		return null
	}

	async function executeCodeInCurrentContext(code: string, params?: JsonRecord) {
		if (runtimeMode === 'hosted') {
			return await executeCodeWithHttp(code, params)
		}
		if (runtimeMode === 'mcp') {
			const hook = getRuntimeHooks().executeCode
			if (typeof hook === 'function') {
				return await hook(code, params)
			}
			return await executeCodeWithHttp(code, params)
		}
		return null
	}

	async function saveSecretInCurrentContext(
		input: SaveSecretInput,
	): Promise<SaveSecretResult> {
		return await saveSecretWithHttp(input)
	}

	async function listSecretsInCurrentContext(
		scope?: GeneratedUiStorageScope,
	): Promise<Array<GeneratedUiSecretMetadata>> {
		try {
			const response = await listSecretsWithHttp(scope ?? undefined)
			return Array.isArray(response) ? response : []
		} catch {
			return []
		}
	}

	async function deleteSecretInCurrentContext(
		input: DeleteSecretInput,
	): Promise<DeleteSecretResult> {
		return await deleteSecretWithHttp(input)
	}

	const kodyWidget = {
		params: runtimeParams,
		sendMessage(text: unknown) {
			if (runtimeMode === 'hosted') {
				if (typeof text === 'string' && text.length > 0) {
					console.info('[kodyWidget] message:', text)
				}
				return false
			}
			if (runtimeMode === 'mcp') {
				const hook = getRuntimeHooks().sendMessage
				return typeof hook === 'function' ? hook(String(text ?? '')) : false
			}
			return appendLocalMessageLogEntry(text)
		},
		openLink(url: string) {
			if (runtimeMode === 'hosted') {
				if (typeof url !== 'string' || url.length === 0) return false
				window.open(url, '_blank', 'noopener,noreferrer')
				return true
			}
			if (runtimeMode === 'mcp') {
				const hook = getRuntimeHooks().openLink
				return typeof hook === 'function' ? hook(url) : false
			}
			return false
		},
		async requestDisplayMode(mode: DisplayMode) {
			return await requestDisplayMode(mode)
		},
		async toggleFullscreen() {
			if (runtimeMode === 'hosted') {
				return 'inline'
			}
			return await requestDisplayMode('fullscreen')
		},
		async executeCode(code: string, params?: JsonRecord) {
			if (typeof code !== 'string' || code.length === 0) return null
			if (params != null && !isRecord(params)) {
				throw new Error('executeCode params must be an object.')
			}
			return await executeCodeInCurrentContext(code, params)
		},
		async saveSecret(input: any): Promise<SaveSecretResult> {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Secret input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Secret name is required.' }
			}
			if (typeof input.value !== 'string' || input.value.length === 0) {
				return { ok: false, error: 'Secret value is required.' }
			}
			return await saveSecretInCurrentContext(input)
		},
		async saveSecrets(input: any): Promise<SaveSecretsResult> {
			if (!Array.isArray(input)) {
				return {
					ok: false,
					results: [
						{
							name: '',
							ok: false,
							error: 'Secret inputs must be an array.',
						},
					],
				}
			}
			const results: SaveSecretsResult['results'] = []
			for (const item of input) {
				if (!item || typeof item !== 'object') {
					results.push({
						name: '',
						ok: false,
						error: 'Each secret input must be an object.',
					})
					continue
				}
				const response = await kodyWidget.saveSecret(item)
				results.push({
					name: typeof item.name === 'string' ? item.name : '',
					ok: response.ok === true,
					...(response.ok === true && response.secret
						? { secret: response.secret }
						: {}),
					...(response.ok === true
						? {}
						: { error: response.error || 'Unable to save secret.' }),
				})
			}
			return {
				ok: results.every((result) => result.ok === true),
				results,
			}
		},
		async saveValue(input: SaveValueInput | any): Promise<SaveValueResult> {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Value input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Value name is required.' }
			}
			if (typeof input.value !== 'string' || input.value.length === 0) {
				return { ok: false, error: 'Value is required.' }
			}
			try {
				const result = await kodyWidget.executeCode(
					buildCodemodeCapabilityExecuteCode('value_set', {
						name: input.name,
						value: input.value,
						description:
							typeof input.description === 'string' ? input.description : '',
						...(coerceStorageScope(input.scope) ? { scope: input.scope } : {}),
					}),
				)
				const saved = coerceValueMetadata(result)
				if (!saved) {
					return { ok: false, error: 'Unable to save value.' }
				}
				return {
					ok: true,
					value: saved,
				}
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error ? error.message : 'Unable to save value.',
				}
			}
		},
		async saveValues(input: any): Promise<SaveValuesResult> {
			if (!Array.isArray(input)) {
				return {
					ok: false,
					results: [
						{
							name: '',
							ok: false,
							error: 'Value inputs must be an array.',
						},
					],
				}
			}
			const results: SaveValuesResult['results'] = []
			for (const item of input) {
				if (!item || typeof item !== 'object') {
					results.push({
						name: '',
						ok: false,
						error: 'Each value input must be an object.',
					})
					continue
				}
				const response = await kodyWidget.saveValue(item)
				results.push({
					name: typeof item.name === 'string' ? item.name : '',
					ok: response.ok === true,
					...(response.ok === true && response.value
						? { value: response.value }
						: {}),
					...(response.ok === true
						? {}
						: { error: response.error || 'Unable to save value.' }),
				})
			}
			return {
				ok: results.every((result) => result.ok === true),
				results,
			}
		},
		async getValue(input: any) {
			if (!input || typeof input !== 'object') {
				throw new Error('Value input must be an object.')
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				throw new Error('Value name is required.')
			}
			const result = await kodyWidget.executeCode(
				buildCodemodeCapabilityExecuteCode('value_get', {
					name: input.name,
					...(coerceStorageScope(input.scope) ? { scope: input.scope } : {}),
				}),
			)
			return coerceValueMetadata(result)
		},
		async listValues(input: any) {
			const scope = coerceStorageScope(
				isRecord(input) ? input.scope : undefined,
			)
			const result = await kodyWidget.executeCode(
				buildCodemodeCapabilityExecuteCode('value_list', {
					...(scope ? { scope } : {}),
				}),
			)
			if (!isRecord(result) || !Array.isArray(result.values)) return []
			return result.values
				.map((value: unknown) => coerceValueMetadata(value))
				.filter((value: GeneratedUiValueMetadata | null) => value != null)
		},
		async deleteValue(input: any) {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Value input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Value name is required.' }
			}
			const scope = coerceStorageScope(input.scope)
			if (!scope) {
				return { ok: false, error: 'Value scope is required.' }
			}
			try {
				const result = await kodyWidget.executeCode(
					buildCodemodeCapabilityExecuteCode('value_delete', {
						name: input.name,
						scope,
					}),
				)
				return {
					ok: true,
					deleted: isRecord(result) ? result.deleted === true : false,
				}
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error ? error.message : 'Unable to delete value.',
				}
			}
		},
		async listSecrets(input: any) {
			const scope = coerceStorageScope(
				isRecord(input) ? input.scope : undefined,
			)
			return await listSecretsInCurrentContext(scope ?? undefined)
		},
		formToObject(form: FormReference) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'formToObject requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			return formDataToObject(new FormData(resolvedForm))
		},
		fillFromSearchParams(form: FormReference, mapping: any) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'fillFromSearchParams requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			const url = getTopLocationUrl()
			const mappingRecord = isRecord(mapping) ? mapping : null
			const fieldNames = new Set(
				Array.from(resolvedForm.elements)
					.map((element) => ('name' in element ? element.name : ''))
					.filter((name) => typeof name === 'string' && name.length > 0),
			)
			for (const name of fieldNames) {
				const fieldName = String(name)
				const mappedValue = mappingRecord?.[fieldName]
				const paramName =
					typeof mappedValue === 'string' && mappedValue.length > 0
						? mappedValue
						: fieldName
				const values = url.searchParams.getAll(paramName)
				if (values.length === 0) continue
				setControlValues(resolvedForm, fieldName, values)
			}
			return kodyWidget.formToObject(resolvedForm)
		},
		persistForm(form: FormReference, options: PersistFormOptions | any) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'persistForm requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			if (
				!isRecord(options) ||
				typeof options.storageKey !== 'string' ||
				options.storageKey.length === 0
			) {
				throw new Error('persistForm requires a storageKey option.')
			}
			const values = kodyWidget.formToObject(resolvedForm)
			const fieldNames = Array.isArray(options.fields)
				? options.fields.filter(
						(field) => typeof field === 'string' && field.length > 0,
					)
				: Object.keys(values)
			const persisted: JsonRecord = {}
			for (const name of fieldNames) {
				if (!(name in values)) continue
				const value = values[name]
				const normalized = Array.isArray(value)
					? value
							.filter((entry) => typeof entry === 'string')
							.map((entry) => entry)
					: typeof value === 'string'
						? value
						: null
				if (normalized != null) {
					persisted[name] = normalized
				}
			}
			localStorage.setItem(options.storageKey, JSON.stringify(persisted))
			return persisted
		},
		restoreForm(form: FormReference, options: PersistFormOptions | any) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'restoreForm requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			if (
				!isRecord(options) ||
				typeof options.storageKey !== 'string' ||
				options.storageKey.length === 0
			) {
				throw new Error('restoreForm requires a storageKey option.')
			}
			const raw = localStorage.getItem(options.storageKey)
			if (!raw) return null
			let parsed = null
			try {
				parsed = JSON.parse(raw)
			} catch {
				return null
			}
			if (!isRecord(parsed)) return null
			for (const [name, value] of Object.entries(parsed)) {
				setControlValues(resolvedForm, name, toStringArray(value))
			}
			return kodyWidget.formToObject(resolvedForm)
		},
		createOAuthState(key: string) {
			if (typeof key !== 'string' || key.length === 0) {
				throw new Error('createOAuthState requires a storage key.')
			}
			const state =
				globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
					? globalThis.crypto.randomUUID()
					: Math.random().toString(36).slice(2) +
						Math.random().toString(36).slice(2)
			const storage = getOAuthStorage()
			storage.setItem(key, state)
			return state
		},
		getOAuthState(key: string) {
			if (typeof key !== 'string' || key.length === 0) return null
			const storage = getOAuthStorage()
			return storage.getItem(key)
		},
		clearOAuthState(key: string) {
			if (typeof key !== 'string' || key.length === 0) return
			const storage = getOAuthStorage()
			storage.removeItem(key)
		},
		validateOAuthCallbackState(input: any) {
			if (
				!isRecord(input) ||
				typeof input.key !== 'string' ||
				input.key.length === 0
			) {
				throw new Error('validateOAuthCallbackState requires a key.')
			}
			const storage = getOAuthStorage()
			const expectedState = storage.getItem(input.key)
			const returnedState =
				typeof input.returnedState === 'string' &&
				input.returnedState.length > 0
					? input.returnedState
					: null
			return {
				valid:
					typeof expectedState === 'string' &&
					expectedState.length > 0 &&
					returnedState != null &&
					expectedState === returnedState,
				expectedState,
				returnedState,
			}
		},
		readOAuthCallback(input: any) {
			const url = getTopLocationUrl(
				isRecord(input) && typeof input.url === 'string'
					? input.url
					: undefined,
			)
			const error = url.searchParams.get('error')
			const errorDescription = url.searchParams.get('error_description')
			if (error) {
				return {
					kind: 'error',
					error,
					errorDescription,
					callbackUrl: url.toString(),
				}
			}
			const code = url.searchParams.get('code')
			if (!code) {
				return { kind: 'none' }
			}
			const storage = getOAuthStorage()
			const state = url.searchParams.get('state')
			const expectedState =
				isRecord(input) && typeof input.expectedStateKey === 'string'
					? storage.getItem(input.expectedStateKey)
					: null
			return {
				kind: 'success',
				code,
				state,
				callbackUrl: url.toString(),
				expectedState,
				stateMatches:
					expectedState != null && state != null
						? expectedState === state
						: null,
			}
		},
		async fetchWithSecrets(input: unknown) {
			const normalized = normalizeFetchWithSecretsInput(input)
			if (!normalized.ok) {
				return {
					ok: false,
					kind: 'execution_error',
					message: normalized.error,
				}
			}
			const fallbackSecretNames = normalizeSecretNameList(
				extractSecretNamesFromValue([
					normalized.value.url,
					Object.values(normalized.value.headers),
					normalized.value.body,
				]),
			)
			try {
				const result = await kodyWidget.executeCode(
					buildFetchWithSecretsExecuteCode(normalized.value),
				)
				return normalizeFetchWithSecretsResult(result)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (
					message.includes('not allowed for host') ||
					message.includes('Secrets require host approval:')
				) {
					const approval = extractApprovalDetails(message, fallbackSecretNames)
					return {
						ok: false,
						kind: 'host_approval_required',
						approvalUrl: approval.approvalUrl,
						message: approval.message,
						host: approval.host,
						secretNames: approval.secretNames,
					}
				}
				return {
					ok: false,
					kind: 'execution_error',
					message,
				}
			}
		},
		async exchangePkceOAuthCode(input: any) {
			if (!isRecord(input)) {
				return {
					ok: false,
					kind: 'execution_error',
					message: 'exchangePkceOAuthCode input must be an object.',
				}
			}
			if (
				typeof input.tokenUrl !== 'string' ||
				typeof input.code !== 'string' ||
				typeof input.redirectUri !== 'string' ||
				typeof input.clientId !== 'string' ||
				typeof input.codeVerifier !== 'string' ||
				input.tokenUrl.length === 0 ||
				input.code.length === 0 ||
				input.redirectUri.length === 0 ||
				input.clientId.length === 0 ||
				input.codeVerifier.length === 0
			) {
				return {
					ok: false,
					kind: 'execution_error',
					message:
						'exchangePkceOAuthCode requires tokenUrl, code, redirectUri, clientId, and codeVerifier.',
				}
			}
			const params = new URLSearchParams()
			params.set('grant_type', 'authorization_code')
			params.set('client_id', input.clientId)
			params.set('code_verifier', input.codeVerifier)
			params.set('code', input.code)
			params.set('redirect_uri', input.redirectUri)
			appendOAuthExtraParams(params, input.extraParams)
			try {
				const response = await fetch(input.tokenUrl, {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: params.toString(),
					cache: 'no-store',
					credentials: 'omit',
				})
				return normalizeFetchWithSecretsResult(
					await readOAuthFetchResult(response),
				)
			} catch (error) {
				return {
					ok: false,
					kind: 'execution_error',
					message:
						error instanceof Error
							? error.message
							: 'PKCE token exchange failed.',
				}
			}
		},
		async exchangeOAuthCodeWithSecrets(input: any) {
			if (!isRecord(input)) {
				return {
					ok: false,
					kind: 'execution_error',
					message: 'exchangeOAuthCodeWithSecrets input must be an object.',
				}
			}
			if (
				typeof input.tokenUrl !== 'string' ||
				typeof input.code !== 'string' ||
				typeof input.redirectUri !== 'string' ||
				typeof input.clientId !== 'string' ||
				typeof input.clientSecretSecretName !== 'string' ||
				input.tokenUrl.length === 0 ||
				input.code.length === 0 ||
				input.redirectUri.length === 0 ||
				input.clientId.length === 0 ||
				input.clientSecretSecretName.length === 0
			) {
				return {
					ok: false,
					kind: 'execution_error',
					message:
						'exchangeOAuthCodeWithSecrets requires tokenUrl, code, redirectUri, clientId, and clientSecretSecretName.',
				}
			}
			const scope = coerceStorageScope(input.scope)
			const scopeSuffix = scope ? '|scope=' + scope : ''
			const params = new URLSearchParams()
			params.set('grant_type', 'authorization_code')
			params.set('client_id', input.clientId)
			params.set(
				'client_secret',
				'{{secret:' + input.clientSecretSecretName + scopeSuffix + '}}',
			)
			params.set('code', input.code)
			params.set('redirect_uri', input.redirectUri)
			appendOAuthExtraParams(params, input.extraParams)
			return await kodyWidget.fetchWithSecrets({
				url: input.tokenUrl,
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: params.toString(),
			})
		},
		async saveOAuthTokens(input: any) {
			if (!isRecord(input) || !isRecord(input.payload)) {
				return {
					ok: false,
					accessTokenSaved: false,
					refreshTokenSaved: false,
					error: 'saveOAuthTokens requires a payload object.',
					results: [],
				}
			}
			if (
				typeof input.accessTokenSecretName !== 'string' ||
				input.accessTokenSecretName.length === 0
			) {
				return {
					ok: false,
					accessTokenSaved: false,
					refreshTokenSaved: false,
					error: 'saveOAuthTokens requires an accessTokenSecretName.',
					results: [],
				}
			}
			const accessToken =
				typeof input.payload.access_token === 'string'
					? input.payload.access_token
					: ''
			const refreshToken =
				typeof input.payload.refresh_token === 'string'
					? input.payload.refresh_token
					: ''
			if (!accessToken) {
				return {
					ok: false,
					accessTokenSaved: false,
					refreshTokenSaved: false,
					error: 'OAuth payload did not include an access_token.',
					results: [],
				}
			}
			const secrets = [
				{
					name: input.accessTokenSecretName,
					value: accessToken,
					description:
						typeof input.accessTokenDescription === 'string'
							? input.accessTokenDescription
							: 'OAuth access token',
					scope: coerceStorageScope(input.scope) ?? undefined,
				},
			]
			if (
				refreshToken &&
				typeof input.refreshTokenSecretName === 'string' &&
				input.refreshTokenSecretName.length > 0
			) {
				secrets.push({
					name: input.refreshTokenSecretName,
					value: refreshToken,
					description:
						typeof input.refreshTokenDescription === 'string'
							? input.refreshTokenDescription
							: 'OAuth refresh token',
					scope: coerceStorageScope(input.scope) ?? undefined,
				})
			}
			const saved = await kodyWidget.saveSecrets(secrets)
			return {
				ok: saved.ok,
				accessTokenSaved: saved.results.some(
					(result) =>
						result.name === input.accessTokenSecretName && result.ok === true,
				),
				refreshTokenSaved:
					typeof input.refreshTokenSecretName === 'string' &&
					input.refreshTokenSecretName.length > 0
						? saved.results.some(
								(result) =>
									result.name === input.refreshTokenSecretName &&
									result.ok === true,
							)
						: false,
				error: saved.ok
					? undefined
					: saved.results.find((result) => result.ok !== true)?.error ||
						'Unable to save OAuth tokens.',
				results: saved.results,
			}
		},
		buildSecretForm(input: BuildSecretFormInput | any) {
			if (!isRecord(input) || !Array.isArray(input.fields)) {
				throw new Error(
					'buildSecretForm requires a form config object with fields.',
				)
			}
			const form = resolveFormReference(input.form)
			if (!(form instanceof HTMLFormElement)) {
				throw new Error(
					'buildSecretForm requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			const controller = {
				form,
				save: async () => {
					const values = kodyWidget.formToObject(form)
					const secrets = input.fields.map((field: any) => {
						if (!field || typeof field !== 'object') {
							throw new Error('Each secret field config must be an object.')
						}
						if (
							typeof field.inputName !== 'string' ||
							field.inputName.length === 0
						) {
							throw new Error('Each secret field config requires inputName.')
						}
						if (
							typeof field.secretName !== 'string' ||
							field.secretName.length === 0
						) {
							throw new Error('Each secret field config requires secretName.')
						}
						const rawValue = pickLastFormValue(values[field.inputName])
						if (typeof rawValue !== 'string' || rawValue.length === 0) {
							throw new Error(
								'Form field "' + field.inputName + '" is required.',
							)
						}
						return {
							name: field.secretName,
							value: rawValue,
							description:
								typeof field.description === 'string' ? field.description : '',
							scope: coerceStorageScope(field.scope) ?? undefined,
						}
					})
					const result = await kodyWidget.saveSecrets(secrets)
					if (result.ok) {
						if (typeof input.onSuccess === 'function') {
							await input.onSuccess(result, values)
						}
					} else if (typeof input.onError === 'function') {
						await input.onError(result, values)
					}
					return result
				},
				destroy: () => {
					form.removeEventListener('submit', handleSubmit)
				},
			}
			async function handleSubmit(event: SubmitEvent) {
				event.preventDefault()
				try {
					await controller.save()
				} catch (error) {
					if (typeof input.onError === 'function') {
						await input.onError(
							{
								ok: false,
								results: [
									{
										name: '',
										ok: false,
										error:
											error instanceof Error ? error.message : String(error),
									},
								],
							},
							kodyWidget.formToObject(form as HTMLFormElement),
						)
						return
					}
					throw error
				}
			}
			form.addEventListener('submit', handleSubmit)
			return controller
		},
		async deleteSecret(input: any) {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Secret input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Secret name is required.' }
			}
			return await deleteSecretInCurrentContext(input)
		},
	}

	kodyWindow.__kodyAppParams = runtimeParams
	currentKodyWidget = kodyWidget
	kodyWindow.params = runtimeParams
	resolveKodyWidgetReady(kodyWidget)

	window.addEventListener('error', (event) => {
		console.error(
			'Generated UI app error:',
			event.error?.message ?? event.message ?? event.error ?? 'Unknown error',
		)
	})

	window.addEventListener('unhandledrejection', (event) => {
		console.error(
			'Generated UI app rejection:',
			event.reason?.message ?? event.reason ?? 'Unknown rejection',
		)
	})
}
