import { createWidgetHostBridge } from './widget-host-bridge.js'

type RenderMode = 'inline_code' | 'saved_app'
type AppRuntime = 'html' | 'javascript'
type DisplayMode = 'inline' | 'fullscreen' | 'pip'
type ThemeName = 'light' | 'dark'
type SecretScope = 'session' | 'app' | 'user'

type SecretMetadata = {
	name: string
	scope: SecretScope
	description: string
	app_id: string | null
	allowed_hosts: Array<string>
	created_at: string
	updated_at: string
	ttl_ms: number | null
}

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

type RenderEnvelope = {
	mode: RenderMode
	code?: string
	appId?: string
	runtime?: AppRuntime
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
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

function coerceSecretScope(value: unknown): SecretScope | null {
	return value === 'session' || value === 'app' || value === 'user'
		? value
		: null
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

function coerceDisplayMode(value: unknown): DisplayMode | null {
	return value === 'inline' || value === 'fullscreen' || value === 'pip'
		? value
		: null
}

function coerceTheme(value: unknown): ThemeName | null {
	return value === 'light' || value === 'dark' ? value : null
}

function injectThemeAttributeIntoHtmlTag(
	htmlTag: string,
	theme: ThemeName | null,
) {
	if (!theme || /\bdata-kody-theme\s*=/i.test(htmlTag)) {
		return htmlTag
	}

	const closingBracketIndex = htmlTag.lastIndexOf('>')
	if (closingBracketIndex === -1) {
		return htmlTag
	}

	return `${htmlTag.slice(0, closingBracketIndex)} data-kody-theme="${theme}">${htmlTag.slice(closingBracketIndex + 1)}`
}

export function injectIntoHtmlDocument(
	code: string,
	injection: string,
	theme: ThemeName | null,
) {
	if (/<head\b[^>]*>/i.test(code)) {
		const withTheme = theme
			? code.replace(/<html\b[^>]*>/i, (match) =>
					injectThemeAttributeIntoHtmlTag(match, theme),
				)
			: code

		return withTheme.replace(
			/<head\b[^>]*>/i,
			(match) => `${match}\n${injection}\n`,
		)
	}

	if (/<html\b[^>]*>/i.test(code)) {
		return code.replace(
			/<html\b[^>]*>/i,
			(match) =>
				`${injectThemeAttributeIntoHtmlTag(match, theme)}<head>${injection}</head>`,
		)
	}

	if (/<\/body>/i.test(code)) {
		return code.replace(/<\/body>/i, `${injection}\n</body>`)
	}

	return `${injection}\n${code}`
}

function escapeHtmlAttribute(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

function decodeHtmlAttribute(value: string) {
	return value
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&')
}

function isNonNavigableUrl(value: string) {
	const normalizedValue = value.trim().toLowerCase()
	return (
		normalizedValue === '' ||
		normalizedValue.startsWith('#') ||
		normalizedValue.startsWith('//') ||
		normalizedValue.startsWith('about:') ||
		normalizedValue.startsWith('blob:') ||
		normalizedValue.startsWith('data:') ||
		normalizedValue.startsWith('javascript:') ||
		normalizedValue.startsWith('mailto:') ||
		normalizedValue.startsWith('tel:')
	)
}

function absolutizeUrl(value: string, baseHref: string | null) {
	if (!baseHref || isNonNavigableUrl(value)) {
		return value
	}

	try {
		return new URL(value).toString()
	} catch {}

	try {
		return new URL(value, baseHref).toString()
	} catch {
		return value
	}
}

function absolutizeSrcset(value: string, baseHref: string | null) {
	return value
		.split(',')
		.map((candidate) => {
			const trimmedCandidate = candidate.trim()
			if (trimmedCandidate.length === 0) {
				return ''
			}

			const [url, ...descriptorParts] = trimmedCandidate.split(/\s+/)
			if (!url) {
				return trimmedCandidate
			}
			return [absolutizeUrl(url, baseHref), ...descriptorParts]
				.filter((part) => part.length > 0)
				.join(' ')
		})
		.join(', ')
}

export function absolutizeHtmlAttributeUrls(
	code: string,
	baseHref: string | null,
) {
	if (!baseHref) {
		return code
	}

	return code.replace(/<[^>]+>/g, (tag) => {
		if (
			tag.startsWith('<!--') ||
			tag.startsWith('<!') ||
			tag.startsWith('<?')
		) {
			return tag
		}

		return tag.replace(
			/(^|\s)(href|src|action|formaction|poster|srcset)=("([^"]*)"|'([^']*)')/gi,
			(
				match,
				prefix,
				attributeName,
				quotedValue,
				doubleQuotedValue,
				singleQuotedValue,
			) => {
				const rawValue =
					typeof doubleQuotedValue === 'string'
						? doubleQuotedValue
						: singleQuotedValue
				const decodedValue = decodeHtmlAttribute(rawValue)
				const nextValue =
					attributeName.toLowerCase() === 'srcset'
						? absolutizeSrcset(decodedValue, baseHref)
						: absolutizeUrl(decodedValue, baseHref)

				if (nextValue === decodedValue) {
					return match
				}

				const quote = quotedValue.startsWith('"') ? '"' : "'"
				return `${prefix}${attributeName}=${quote}${escapeHtmlAttribute(nextValue)}${quote}`
			},
		)
	})
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

function postChildResponse(
	targetWindow: WindowProxy,
	type: string,
	requestId: string,
	response: unknown,
) {
	targetWindow.postMessage(
		{
			type,
			payload: {
				requestId,
				response,
			},
		},
		'*',
	)
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
	const appSession = coerceAppSession(value.appSession)
	return { mode: renderSource, code, appId, runtime, appSession }
}

function getEnvelopeFromRenderData(renderData: RenderDataEnvelope | undefined) {
	const toolOutput = isRecord(renderData?.toolOutput)
		? renderData.toolOutput
		: undefined
	return coerceRenderEnvelope(toolOutput)
}

function initializeGeneratedUiShell() {
	const documentRef = globalThis.document
	if (!documentRef || !globalThis.window) return

	const frameElementMaybe = documentRef.querySelector<HTMLIFrameElement>(
		'[data-generated-ui-frame]',
	)
	if (!frameElementMaybe) {
		return
	}
	const frameElement = frameElementMaybe
	const childMessagePrefix = 'kody-generated-ui:'

	let latestRenderData: RenderDataEnvelope | undefined
	let latestEnvelope: RenderEnvelope | null = null
	let frameResizeObserver: ResizeObserver | null = null
	let sizeMeasurementScheduled = false
	let lastMeasuredFrameSize: MeasuredFrameSize | null = null

	function getBaseHref() {
		try {
			return new URL('/', import.meta.url).toString()
		} catch {
			return null
		}
	}

	function buildSavedUiEndpoint(
		uiId: string,
		endpoint: 'source' | 'execute' | 'secrets' | 'delete-secret',
	) {
		const baseHref = getBaseHref()
		if (!baseHref) {
			return null
		}
		const path =
			endpoint === 'delete-secret'
				? `/ui-api/${encodeURIComponent(uiId)}/secrets/delete`
				: `/ui-api/${encodeURIComponent(uiId)}/${endpoint}`
		return new URL(path, baseHref).toString()
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

	function getAppSourceRequestTarget(appId: string) {
		const appSession = latestEnvelope?.appSession ?? null
		if (appSession?.token) {
			const url = new URL(appSession.endpoints.source)
			if (!url.searchParams.has('app_id')) {
				url.searchParams.set('app_id', appId)
			}
			return {
				url: url.toString(),
				token: appSession.token,
			}
		}
		const url = buildSavedUiEndpoint(appId, 'source')
		return url ? { url } : null
	}

	function getSessionRequestTarget(
		type: 'execute' | 'secrets' | 'delete-secret',
	) {
		const appSession = latestEnvelope?.appSession ?? null
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

	async function executeCodeWithHttp(code: string) {
		const target = getSessionRequestTarget('execute')
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

	async function saveSecretWithHttp(input: {
		name: string
		value: string
		description?: string
		scope?: SecretScope
	}) {
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
			secret: isRecord(payload.secret) ? payload.secret : undefined,
		}
	}

	async function listSecretsWithHttp(scope?: SecretScope) {
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
		return payload.secrets.filter((secret): secret is SecretMetadata => {
			return (
				isRecord(secret) &&
				typeof secret.name === 'string' &&
				coerceSecretScope(secret.scope) != null &&
				typeof secret.description === 'string' &&
				(secret.app_id == null || typeof secret.app_id === 'string') &&
				Array.isArray(secret.allowed_hosts) &&
				secret.allowed_hosts.every((host) => typeof host === 'string') &&
				typeof secret.created_at === 'string' &&
				typeof secret.updated_at === 'string' &&
				(secret.ttl_ms == null ||
					(typeof secret.ttl_ms === 'number' &&
						Number.isFinite(secret.ttl_ms) &&
						secret.ttl_ms >= 0))
			)
		})
	}

	async function deleteSecretWithHttp(input: {
		name: string
		scope?: SecretScope
	}) {
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

	function escapeInlineModuleSource(code: string) {
		return code.replace(/<\/script/gi, '<\\/script')
	}

	function buildShellStyles(theme: ThemeName | null) {
		const themeSelector = theme ? `html[data-kody-theme="${theme}"]` : ':root'
		return `
:root {
	color-scheme: light dark;
	--font-body: ui-sans-serif, system-ui, sans-serif;
	--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	--spacing-1: 0.25rem;
	--spacing-2: 0.5rem;
	--spacing-3: 0.75rem;
	--spacing-4: 1rem;
	--spacing-6: 1.5rem;
	--radius-2: 0.5rem;
	--radius-3: 0.75rem;
	--shadow-1: 0 1px 2px rgb(15 23 42 / 0.08);
}

${themeSelector} {
	--color-bg: #ffffff;
	--color-surface: #f8fafc;
	--color-fg: #0f172a;
	--color-muted: #475569;
	--color-border: #dbe2ea;
	--color-accent: #2563eb;
	--color-accent-contrast: #ffffff;
	--color-code-bg: rgb(15 23 42 / 0.06);
}

@media (prefers-color-scheme: dark) {
	:root:not([data-kody-theme="light"]) {
		--color-bg: #0f172a;
		--color-surface: #162033;
		--color-fg: #e5eef8;
		--color-muted: #a5b4c7;
		--color-border: #2a3950;
		--color-accent: #60a5fa;
		--color-accent-contrast: #0f172a;
		--color-code-bg: rgb(148 163 184 / 0.16);
	}
}

html[data-kody-theme="dark"] {
	color-scheme: dark;
	--color-bg: #0f172a;
	--color-surface: #162033;
	--color-fg: #e5eef8;
	--color-muted: #a5b4c7;
	--color-border: #2a3950;
	--color-accent: #60a5fa;
	--color-accent-contrast: #0f172a;
	--color-code-bg: rgb(148 163 184 / 0.16);
}

html[data-kody-theme="light"] {
	color-scheme: light;
}

:where(html) {
	min-height: 100%;
	background: var(--color-bg);
	color: var(--color-fg);
}

:where(body) {
	min-height: 100%;
	margin: 0;
	padding: var(--spacing-4);
	background: var(--color-bg);
	color: var(--color-fg);
	font: 400 14px/1.5 var(--font-body);
}

:where(body[data-kody-runtime="javascript"]) {
	padding: 0;
}

:where(*, *::before, *::after) {
	box-sizing: border-box;
}

:where(a) {
	color: var(--color-accent);
}

:where(p, ul, ol, dl, pre, table, blockquote, fieldset) {
	margin: 0 0 var(--spacing-4);
}

:where(h1, h2, h3, h4, h5, h6) {
	margin: 0 0 var(--spacing-3);
	line-height: 1.2;
}

:where(h1) {
	font-size: 1.875rem;
}

:where(h2) {
	font-size: 1.5rem;
}

:where(h3) {
	font-size: 1.25rem;
}

:where(ul, ol) {
	padding-left: 1.5rem;
}

:where(hr) {
	border: 0;
	border-top: 1px solid var(--color-border);
	margin: var(--spacing-6) 0;
}

:where(code, kbd, samp) {
	font-family: var(--font-mono);
	font-size: 0.95em;
}

:where(code) {
	background: var(--color-code-bg);
	border-radius: 0.375rem;
	padding: 0.1rem 0.35rem;
}

:where(pre) {
	overflow-x: auto;
	padding: var(--spacing-3);
	background: var(--color-code-bg);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-2);
}

:where(pre code) {
	background: transparent;
	padding: 0;
}

:where(form) {
	display: grid;
	gap: var(--spacing-4);
}

:where(label) {
	display: grid;
	gap: var(--spacing-2);
	font-weight: 600;
}

:where(input, button, textarea, select) {
	font: inherit;
}

:where(input:not([type="checkbox"]):not([type="radio"]), textarea, select) {
	width: 100%;
	padding: var(--spacing-2) var(--spacing-3);
	background: var(--color-surface);
	color: var(--color-fg);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-2);
	box-shadow: inset 0 1px 2px rgb(15 23 42 / 0.04);
}

:where(textarea) {
	min-height: 7rem;
	resize: vertical;
}

:where(input[type="checkbox"], input[type="radio"]) {
	accent-color: var(--color-accent);
}

:where(button) {
	width: fit-content;
	padding: var(--spacing-2) var(--spacing-4);
	background: var(--color-accent);
	color: var(--color-accent-contrast);
	border: 1px solid transparent;
	border-radius: var(--radius-2);
	box-shadow: var(--shadow-1);
	cursor: pointer;
}

:where(button:disabled, input:disabled, textarea:disabled, select:disabled) {
	opacity: 0.7;
	cursor: not-allowed;
}

:where(button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible) {
	outline: 2px solid var(--color-accent);
	outline-offset: 2px;
}

:where(table) {
	width: 100%;
	border-collapse: collapse;
}

:where(th, td) {
	padding: var(--spacing-2) var(--spacing-3);
	border: 1px solid var(--color-border);
	text-align: left;
}

:where(th) {
	background: var(--color-surface);
}

:where(blockquote) {
	margin-left: 0;
	padding-left: var(--spacing-4);
	border-left: 3px solid var(--color-border);
	color: var(--color-muted);
}

:where([data-generated-ui-root]) {
	min-height: 100%;
}
		`.trim()
	}

	function buildHeadInjection(theme: ThemeName | null) {
		return `
<style>
${buildShellStyles(theme)}
</style>
<script>
${buildChildBridgeRuntimeSource()}
</script>
		`.trim()
	}

	function buildChildBridgeRuntimeSource() {
		return `
const shellMessagePrefix = '${childMessagePrefix}';
let requestCounter = 0;
function nextRequestId() {
	requestCounter += 1;
	return 'generated-ui-' + requestCounter;
}
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function coerceSecretScope(value) {
	return value === 'session' || value === 'app' || value === 'user' ? value : null;
}
function normalizeSecretNameList(values) {
	return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}
function extractSecretNamesFromValue(value, collected = []) {
	if (typeof value === 'string') {
		for (const match of value.matchAll(/\\{\\{secret:([a-zA-Z0-9._-]+)/g)) {
			if (match[1]) collected.push(match[1]);
		}
		return collected;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			extractSecretNamesFromValue(entry, collected);
		}
		return collected;
	}
	if (isRecord(value)) {
		for (const entry of Object.values(value)) {
			extractSecretNamesFromValue(entry, collected);
		}
	}
	return collected;
}
function extractApprovalDetails(message, fallbackSecretNames = []) {
	const text = typeof message === 'string' ? message : String(message ?? '');
	const secretNames = normalizeSecretNameList([
		...Array.from(text.matchAll(/Secret "([^"]+)"/g)).map((match) => match[1]).filter(Boolean),
		...fallbackSecretNames,
	]);
	const hostMatch = text.match(/host "([^"]+)"/);
	let approvalUrl = null;
	for (const part of text.split(/\\s+/)) {
		if (part.startsWith('http://') || part.startsWith('https://')) {
			approvalUrl = part.replace(/[),.;]+$/, '');
			break;
		}
	}
	return {
		message: text,
		approvalUrl,
		host: hostMatch ? hostMatch[1] : null,
		secretNames,
	};
}
function resolveFormReference(formRef) {
	if (typeof formRef === 'string') {
		return document.querySelector(formRef);
	}
	return formRef && typeof formRef === 'object' ? formRef : null;
}
function formDataToObject(formData) {
	const result = {};
	for (const name of new Set(formData.keys())) {
		const all = formData.getAll(name);
		result[name] = all.length > 1 ? all : (all[0] ?? null);
	}
	return result;
}
function pickLastFormValue(value) {
	if (Array.isArray(value)) {
		return value.length > 0 ? value[value.length - 1] : null;
	}
	return value ?? null;
}
function toStringArray(value) {
	if (Array.isArray(value)) {
		return value.map((entry) => (typeof entry === 'string' ? entry : String(entry)));
	}
	if (value == null) return [];
	return [typeof value === 'string' ? value : String(value)];
}
function setControlValues(form, name, values) {
	const controls = Array.from(form.elements).filter((element) => {
		return element && typeof element === 'object' && 'name' in element && element.name === name;
	});
	if (controls.length === 0) return;
	for (const control of controls) {
		if (!control || typeof control !== 'object') continue;
		if ('type' in control && (control.type === 'checkbox' || control.type === 'radio')) {
			const controlValue = typeof control.value === 'string' && control.value.length > 0 ? control.value : 'on';
			control.checked = values.includes(controlValue) || (control.type === 'checkbox' && controlValue === 'on' && values.some((value) => value === 'true' || value === '1' || value === 'on'));
			continue;
		}
		if ('multiple' in control && control.multiple && 'options' in control && control.options) {
			for (const option of Array.from(control.options)) {
				option.selected = values.includes(option.value);
			}
			continue;
		}
		if ('value' in control) {
			control.value = values.length > 0 ? values[values.length - 1] : '';
		}
	}
}
function getTopLocationUrl(inputUrl) {
	if (inputUrl) {
		return new URL(inputUrl, window.location.href);
	}
	try {
		if (window.top && window.top.location && window.top.location.href) {
			return new URL(window.top.location.href);
		}
	} catch {}
	return new URL(window.location.href);
}
function normalizeFetchWithSecretsInput(input) {
	if (!isRecord(input)) {
		return { ok: false, error: 'fetchWithSecrets input must be an object.' };
	}
	if (typeof input.url !== 'string' || input.url.length === 0) {
		return { ok: false, error: 'fetchWithSecrets requires a url.' };
	}
	const headers = {};
	if (isRecord(input.headers)) {
		for (const [key, value] of Object.entries(input.headers)) {
			if (typeof value === 'string') {
				headers[key] = value;
			}
		}
	}
	let body = input.body;
	if (body != null && typeof body !== 'string') {
		body = JSON.stringify(body);
		const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
		if (!hasContentType) {
			headers['Content-Type'] = 'application/json';
		}
	}
	return {
		ok: true,
		value: {
			url: input.url,
			method: typeof input.method === 'string' && input.method.length > 0 ? input.method.toUpperCase() : 'GET',
			headers,
			body: typeof body === 'string' ? body : undefined,
		},
	};
}
function buildFetchWithSecretsExecuteCode(input) {
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
		'  if (/\\\\bjson\\\\b/i.test(contentType) && text) {',
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
	].filter(Boolean).join('\\n');
}
function normalizeFetchWithSecretsResult(result) {
	if (!isRecord(result)) {
		return {
			ok: false,
			kind: 'execution_error',
			message: 'fetchWithSecrets returned an invalid result.',
		};
	}
	const headers = isRecord(result.headers)
		? Object.fromEntries(
				Object.entries(result.headers).filter((entry) => typeof entry[1] === 'string'),
			)
		: {};
	const status = typeof result.status === 'number' ? result.status : 0;
	const text =
		typeof result.text === 'string' || result.text == null ? result.text : null;
	const data = 'data' in result ? result.data : null;
	if (result.ok === true) {
		return {
			ok: true,
			status,
			headers,
			data,
			text,
		};
	}
	return {
		ok: false,
		kind: 'http_error',
		status,
		headers,
		data,
		text,
	};
}
function waitForShellMessage(type, requestId) {
	return new Promise((resolve) => {
		function handleMessage(event) {
			const data = event.data;
			if (!data || typeof data !== 'object') return;
			if (data.type !== type) return;
			const payload = data.payload;
			if (!payload || typeof payload !== 'object') return;
			if (payload.requestId !== requestId) return;
			window.removeEventListener('message', handleMessage);
			resolve(payload);
		}
		window.addEventListener('message', handleMessage);
	});
}
function postRequestAndWaitForShellMessage(type, payload, responseType, requestId) {
	const pending = waitForShellMessage(responseType, requestId);
	window.parent.postMessage({
		type,
		payload,
	}, '*');
	return pending;
}
async function requestSecretAction(type, input, responseType) {
	if (window.parent === window) return null;
	const requestId = nextRequestId();
	const payload = await postRequestAndWaitForShellMessage(
		shellMessagePrefix + type,
		{
			requestId,
			input,
		},
		shellMessagePrefix + responseType,
		requestId,
	);
	return payload && typeof payload === 'object' ? payload.response : null;
}
window.kodyWidget = {
	sendMessage(text) {
		if (window.parent === window) return false;
		window.parent.postMessage({
			type: shellMessagePrefix + 'send-message',
			payload: { text },
		}, '*');
		return true;
	},
	openLink(url) {
		if (window.parent === window) return false;
		window.parent.postMessage({
			type: shellMessagePrefix + 'open-link',
			payload: { url },
		}, '*');
		return true;
	},
	async requestDisplayMode(mode) {
		if (window.parent === window) return null;
		const requestId = nextRequestId();
		const payload = await postRequestAndWaitForShellMessage(
			shellMessagePrefix + 'request-display-mode',
			{ requestId, mode },
			shellMessagePrefix + 'display-mode-result',
			requestId,
		);
		return typeof payload.mode === 'string' ? payload.mode : null;
	},
	async toggleFullscreen() {
		return await this.requestDisplayMode('fullscreen');
	},
	async executeCode(code) {
		if (typeof code !== 'string' || code.length === 0) return null;
		if (window.parent === window) return null;
		const requestId = nextRequestId();
		const payload = await postRequestAndWaitForShellMessage(
			shellMessagePrefix + 'execute-code',
			{
				requestId,
				code,
			},
			shellMessagePrefix + 'execute-result',
			requestId,
		);
		if (typeof payload.errorMessage === 'string') {
			throw new Error(payload.errorMessage);
		}
		return 'result' in payload ? payload.result ?? null : null;
	},
	async saveSecret(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: 'Secret input must be an object.' };
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			return { ok: false, error: 'Secret name is required.' };
		}
		if (typeof input.value !== 'string' || input.value.length === 0) {
			return { ok: false, error: 'Secret value is required.' };
		}
		const response = await requestSecretAction(
			'save-secret',
			input,
			'save-secret-result',
		);
		return response && typeof response === 'object'
			? response
			: { ok: false, error: 'Unable to save secret.' };
	},
	async saveSecrets(input) {
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
			};
		}
		const results = [];
		for (const item of input) {
			if (!item || typeof item !== 'object') {
				results.push({
					name: '',
					ok: false,
					error: 'Each secret input must be an object.',
				});
				continue;
			}
			const response = await this.saveSecret(item);
			results.push({
				name: typeof item.name === 'string' ? item.name : '',
				ok: response.ok === true,
				...(response.secret ? { secret: response.secret } : {}),
				...(response.ok === true ? {} : { error: response.error || 'Unable to save secret.' }),
			});
		}
		return {
			ok: results.every((result) => result.ok === true),
			results,
		};
	},
	async listSecrets(input) {
		const response = await requestSecretAction(
			'list-secrets',
			input ?? {},
			'list-secrets-result',
		);
		return Array.isArray(response) ? response : [];
	},
	formToObject(form) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('formToObject requires an HTMLFormElement or a selector that resolves to one.');
		}
		return formDataToObject(new FormData(resolvedForm));
	},
	fillFromSearchParams(form, mapping) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('fillFromSearchParams requires an HTMLFormElement or a selector that resolves to one.');
		}
		const url = getTopLocationUrl();
		const fieldNames = new Set(
			Array.from(resolvedForm.elements)
				.map((element) => ('name' in element ? element.name : ''))
				.filter(Boolean),
		);
		for (const name of fieldNames) {
			const paramName =
				isRecord(mapping) && typeof mapping[name] === 'string' && mapping[name].length > 0
					? mapping[name]
					: name;
			const values = url.searchParams.getAll(paramName);
			if (values.length === 0) continue;
			setControlValues(resolvedForm, name, values);
		}
		return this.formToObject(resolvedForm);
	},
	persistForm(form, options) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('persistForm requires an HTMLFormElement or a selector that resolves to one.');
		}
		if (!isRecord(options) || typeof options.storageKey !== 'string' || options.storageKey.length === 0) {
			throw new Error('persistForm requires a storageKey option.');
		}
		const values = this.formToObject(resolvedForm);
		const fieldNames = Array.isArray(options.fields)
			? options.fields.filter((field) => typeof field === 'string' && field.length > 0)
			: Object.keys(values);
		const persisted = {};
		for (const name of fieldNames) {
			if (!(name in values)) continue;
			const value = values[name];
			const normalized = Array.isArray(value)
				? value.filter((entry) => typeof entry === 'string').map((entry) => entry)
				: typeof value === 'string'
					? value
					: null;
			if (normalized != null) {
				persisted[name] = normalized;
			}
		}
		localStorage.setItem(options.storageKey, JSON.stringify(persisted));
		return persisted;
	},
	restoreForm(form, options) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('restoreForm requires an HTMLFormElement or a selector that resolves to one.');
		}
		if (!isRecord(options) || typeof options.storageKey !== 'string' || options.storageKey.length === 0) {
			throw new Error('restoreForm requires a storageKey option.');
		}
		const raw = localStorage.getItem(options.storageKey);
		if (!raw) return null;
		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!isRecord(parsed)) return null;
		for (const [name, value] of Object.entries(parsed)) {
			setControlValues(resolvedForm, name, toStringArray(value));
		}
		return this.formToObject(resolvedForm);
	},
	createOAuthState(key) {
		if (typeof key !== 'string' || key.length === 0) {
			throw new Error('createOAuthState requires a storage key.');
		}
		const state =
			globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
				? globalThis.crypto.randomUUID()
				: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		sessionStorage.setItem(key, state);
		return state;
	},
	getOAuthState(key) {
		if (typeof key !== 'string' || key.length === 0) return null;
		return sessionStorage.getItem(key);
	},
	clearOAuthState(key) {
		if (typeof key !== 'string' || key.length === 0) return;
		sessionStorage.removeItem(key);
	},
	validateOAuthCallbackState(input) {
		if (!isRecord(input) || typeof input.key !== 'string' || input.key.length === 0) {
			throw new Error('validateOAuthCallbackState requires a key.');
		}
		const expectedState = sessionStorage.getItem(input.key);
		const returnedState =
			typeof input.returnedState === 'string' && input.returnedState.length > 0
				? input.returnedState
				: null;
		return {
			valid:
				typeof expectedState === 'string' &&
				expectedState.length > 0 &&
				returnedState != null &&
				expectedState === returnedState,
			expectedState,
			returnedState,
		};
	},
	readOAuthCallback(input) {
		const url = getTopLocationUrl(isRecord(input) && typeof input.url === 'string' ? input.url : undefined);
		const error = url.searchParams.get('error');
		const errorDescription = url.searchParams.get('error_description');
		if (error) {
			return {
				kind: 'error',
				error,
				errorDescription,
				callbackUrl: url.toString(),
			};
		}
		const code = url.searchParams.get('code');
		if (!code) {
			return { kind: 'none' };
		}
		const state = url.searchParams.get('state');
		const expectedState =
			isRecord(input) && typeof input.expectedStateKey === 'string'
				? sessionStorage.getItem(input.expectedStateKey)
				: null;
		return {
			kind: 'success',
			code,
			state,
			callbackUrl: url.toString(),
			expectedState,
			stateMatches:
				expectedState != null && state != null ? expectedState === state : null,
		};
	},
	async fetchWithSecrets(input) {
		const normalized = normalizeFetchWithSecretsInput(input);
		if (!normalized.ok) {
			return {
				ok: false,
				kind: 'execution_error',
				message: normalized.error,
			};
		}
		const fallbackSecretNames = normalizeSecretNameList(
			extractSecretNamesFromValue([
				normalized.value.url,
				Object.values(normalized.value.headers),
				normalized.value.body,
			]),
		);
		try {
			const result = await this.executeCode(
				buildFetchWithSecretsExecuteCode(normalized.value),
			);
			return normalizeFetchWithSecretsResult(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('not allowed for host')) {
				const approval = extractApprovalDetails(message, fallbackSecretNames);
				return {
					ok: false,
					kind: 'host_approval_required',
					approvalUrl: approval.approvalUrl,
					message: approval.message,
					host: approval.host,
					secretNames: approval.secretNames,
				};
			}
			return {
				ok: false,
				kind: 'execution_error',
				message,
			};
		}
	},
	async exchangeOAuthCode(input) {
		if (!isRecord(input)) {
			return {
				ok: false,
				kind: 'execution_error',
				message: 'exchangeOAuthCode input must be an object.',
			};
		}
		if (
			typeof input.tokenUrl !== 'string' ||
			typeof input.code !== 'string' ||
			typeof input.redirectUri !== 'string' ||
			typeof input.clientIdSecretName !== 'string' ||
			typeof input.clientSecretSecretName !== 'string' ||
			input.tokenUrl.length === 0 ||
			input.code.length === 0 ||
			input.redirectUri.length === 0 ||
			input.clientIdSecretName.length === 0 ||
			input.clientSecretSecretName.length === 0
		) {
			return {
				ok: false,
				kind: 'execution_error',
				message: 'exchangeOAuthCode requires tokenUrl, code, redirectUri, clientIdSecretName, and clientSecretSecretName.',
			};
		}
		const scope = coerceSecretScope(input.scope);
		const scopeSuffix = scope ? '|scope=' + scope : '';
		const params = new URLSearchParams();
		params.set('client_id', '{{secret:' + input.clientIdSecretName + scopeSuffix + '}}');
		params.set('client_secret', '{{secret:' + input.clientSecretSecretName + scopeSuffix + '}}');
		params.set('code', input.code);
		params.set('redirect_uri', input.redirectUri);
		if (isRecord(input.extraParams)) {
			for (const [key, value] of Object.entries(input.extraParams)) {
				if (value == null) continue;
				params.set(key, typeof value === 'string' ? value : String(value));
			}
		}
		return await this.fetchWithSecrets({
			url: input.tokenUrl,
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: params.toString(),
		});
	},
	async saveOAuthTokens(input) {
		if (!isRecord(input) || !isRecord(input.payload)) {
			return {
				ok: false,
				accessTokenSaved: false,
				refreshTokenSaved: false,
				error: 'saveOAuthTokens requires a payload object.',
				results: [],
			};
		}
		if (typeof input.accessTokenSecretName !== 'string' || input.accessTokenSecretName.length === 0) {
			return {
				ok: false,
				accessTokenSaved: false,
				refreshTokenSaved: false,
				error: 'saveOAuthTokens requires an accessTokenSecretName.',
				results: [],
			};
		}
		const accessToken = typeof input.payload.access_token === 'string' ? input.payload.access_token : '';
		const refreshToken = typeof input.payload.refresh_token === 'string' ? input.payload.refresh_token : '';
		if (!accessToken) {
			return {
				ok: false,
				accessTokenSaved: false,
				refreshTokenSaved: false,
				error: 'OAuth payload did not include an access_token.',
				results: [],
			};
		}
		const secrets = [
			{
				name: input.accessTokenSecretName,
				value: accessToken,
				description:
					typeof input.accessTokenDescription === 'string'
						? input.accessTokenDescription
						: 'OAuth access token',
				scope: coerceSecretScope(input.scope) ?? undefined,
			},
		];
		if (refreshToken && typeof input.refreshTokenSecretName === 'string' && input.refreshTokenSecretName.length > 0) {
			secrets.push({
				name: input.refreshTokenSecretName,
				value: refreshToken,
				description:
					typeof input.refreshTokenDescription === 'string'
						? input.refreshTokenDescription
						: 'OAuth refresh token',
				scope: coerceSecretScope(input.scope) ?? undefined,
			});
		}
		const saved = await this.saveSecrets(secrets);
		return {
			ok: saved.ok,
			accessTokenSaved: saved.results.some((result) => result.name === input.accessTokenSecretName && result.ok === true),
			refreshTokenSaved:
				typeof input.refreshTokenSecretName === 'string' && input.refreshTokenSecretName.length > 0
					? saved.results.some((result) => result.name === input.refreshTokenSecretName && result.ok === true)
					: false,
			error: saved.ok ? undefined : (saved.results.find((result) => result.ok !== true)?.error || 'Unable to save OAuth tokens.'),
			results: saved.results,
		};
	},
	buildSecretForm(input) {
		if (!isRecord(input) || !Array.isArray(input.fields)) {
			throw new Error('buildSecretForm requires a form config object with fields.');
		}
		const form = resolveFormReference(input.form);
		if (!(form instanceof HTMLFormElement)) {
			throw new Error('buildSecretForm requires an HTMLFormElement or a selector that resolves to one.');
		}
		const controller = {
			form,
			save: async () => {
				const values = window.kodyWidget.formToObject(form);
				const secrets = input.fields.map((field) => {
					if (!field || typeof field !== 'object') {
						throw new Error('Each secret field config must be an object.');
					}
					if (typeof field.inputName !== 'string' || field.inputName.length === 0) {
						throw new Error('Each secret field config requires inputName.');
					}
					if (typeof field.secretName !== 'string' || field.secretName.length === 0) {
						throw new Error('Each secret field config requires secretName.');
					}
					const rawValue = pickLastFormValue(values[field.inputName]);
					if (typeof rawValue !== 'string' || rawValue.length === 0) {
						throw new Error('Form field "' + field.inputName + '" is required.');
					}
					return {
						name: field.secretName,
						value: rawValue,
						description:
							typeof field.description === 'string' ? field.description : '',
						scope: coerceSecretScope(field.scope) ?? undefined,
					};
				});
				const result = await window.kodyWidget.saveSecrets(secrets);
				if (result.ok) {
					if (typeof input.onSuccess === 'function') {
						await input.onSuccess(result, values);
					}
				} else if (typeof input.onError === 'function') {
					await input.onError(result, values);
				}
				return result;
			},
			destroy: () => {
				form.removeEventListener('submit', handleSubmit);
			},
		};
		async function handleSubmit(event) {
			event.preventDefault();
			try {
				await controller.save();
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
						window.kodyWidget.formToObject(form),
					);
					return;
				}
				throw error;
			}
		}
		form.addEventListener('submit', handleSubmit);
		return controller;
	},
	async deleteSecret(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: 'Secret input must be an object.' };
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			return { ok: false, error: 'Secret name is required.' };
		}
		const response = await requestSecretAction(
			'delete-secret',
			input,
			'delete-secret-result',
		);
		return response && typeof response === 'object'
			? response
			: { ok: false, error: 'Unable to delete secret.' };
	},
};
window.addEventListener('error', (event) => {
	console.error(
		'Generated UI app error:',
		event.error?.message ?? event.message ?? event.error ?? 'Unknown error',
	);
});
window.addEventListener('unhandledrejection', (event) => {
	console.error(
		'Generated UI app rejection:',
		event.reason?.message ?? event.reason ?? 'Unknown rejection',
	);
});
		`.trim()
	}

	function buildInlineModuleSource(code: string) {
		const safeCode = escapeInlineModuleSource(code)
		return `
${buildChildBridgeRuntimeSource()}
${safeCode}
		`.trim()
	}

	function renderErrorDocument(message: string) {
		frameElement.srcdoc = `
<!doctype html>
<html lang="en">
	<body style="margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;">
		<pre style="margin:0;white-space:pre-wrap;word-break:break-word;">${message
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')}</pre>
	</body>
</html>
		`.trim()
	}

	function resetFrameSizeTracking() {
		frameResizeObserver?.disconnect()
		frameResizeObserver = null
		lastMeasuredFrameSize = null
		sizeMeasurementScheduled = false
	}

	async function notifyMeasuredFrameSize() {
		const nextSize = measureRenderedFrameSize(frameElement.contentDocument)
		if (
			!nextSize ||
			(lastMeasuredFrameSize?.height === nextSize.height &&
				lastMeasuredFrameSize?.width === nextSize.width)
		) {
			return
		}
		lastMeasuredFrameSize = nextSize
		await hostBridge.sendSizeChanged(nextSize)
	}

	function scheduleMeasuredFrameSizeNotification() {
		if (sizeMeasurementScheduled) return
		sizeMeasurementScheduled = true
		globalThis.requestAnimationFrame(() => {
			sizeMeasurementScheduled = false
			void notifyMeasuredFrameSize()
		})
	}

	function observeRenderedFrameSize() {
		resetFrameSizeTracking()
		const childDocument = frameElement.contentDocument
		if (!childDocument || typeof ResizeObserver !== 'function') {
			void notifyMeasuredFrameSize()
			return
		}
		const observedElements = [
			childDocument.documentElement,
			childDocument.body,
		].filter((element): element is HTMLElement => element != null)
		if (observedElements.length === 0) {
			void notifyMeasuredFrameSize()
			return
		}
		frameResizeObserver = new ResizeObserver(() => {
			scheduleMeasuredFrameSizeNotification()
		})
		for (const element of observedElements) {
			frameResizeObserver.observe(element)
		}
		scheduleMeasuredFrameSizeNotification()
		globalThis.setTimeout(() => {
			scheduleMeasuredFrameSizeNotification()
		}, 0)
	}

	function buildHtmlDocumentFromFragment(code: string) {
		const theme = coerceTheme(latestRenderData?.theme)
		return `
<!doctype html>
<html lang="en"${theme ? ` data-kody-theme="${theme}"` : ''}>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${buildHeadInjection(theme)}
	</head>
	<body data-kody-runtime="fragment">
${code}
	</body>
</html>
		`.trim()
	}

	function setFrameSource(code: string, runtime: AppRuntime) {
		resetFrameSizeTracking()
		if (runtime === 'javascript') {
			const inlineModuleSource = buildInlineModuleSource(code)
			const theme = coerceTheme(latestRenderData?.theme)
			frameElement.srcdoc = `
<!doctype html>
<html lang="en"${theme ? ` data-kody-theme="${theme}"` : ''}>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<style>
${buildShellStyles(theme)}
		</style>
	</head>
	<body data-kody-runtime="javascript">
		<div id="app" data-generated-ui-root></div>
		<script type="module">
${inlineModuleSource}
		</script>
	</body>
</html>
			`.trim()
			return
		}

		const theme = coerceTheme(latestRenderData?.theme)
		const htmlSource = /<(?:!doctype|html|head|body)\b/i.test(code)
			? injectIntoHtmlDocument(code, buildHeadInjection(theme), theme)
			: buildHtmlDocumentFromFragment(code)
		frameElement.srcdoc = absolutizeHtmlAttributeUrls(htmlSource, getBaseHref())
	}

	async function resolveSavedAppCode(appId: string) {
		const target = getAppSourceRequestTarget(appId)
		if (!target) {
			throw new Error('Failed to load saved app source.')
		}
		const { response, payload } = await fetchJsonResponse({
			url: target.url,
			method: 'GET',
			token: target.token,
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
	}

	async function renderEnvelope(envelope: RenderEnvelope | null) {
		latestEnvelope = envelope
		if (!envelope) {
			resetFrameSizeTracking()
			frameElement.srcdoc = ''
			return
		}

		if (envelope.mode === 'inline_code') {
			if (!envelope.code) {
				renderErrorDocument('The tool result did not include inline code.')
				return
			}
			setFrameSource(envelope.code, envelope.runtime ?? 'html')
			return
		}

		if (!envelope.appId) {
			renderErrorDocument('The tool result did not include an app_id.')
			return
		}

		try {
			const resolved = await resolveSavedAppCode(envelope.appId)
			if (latestEnvelope !== envelope) return
			setFrameSource(resolved.code, resolved.runtime)
		} catch (error) {
			if (latestEnvelope !== envelope) return
			const message =
				error instanceof Error ? error.message : 'Unknown app loading error.'
			renderErrorDocument(message)
		}
	}

	async function requestDisplayMode(mode: DisplayMode) {
		const displayMode = latestRenderData?.displayMode
		const availableDisplayModes = Array.isArray(
			latestRenderData?.availableDisplayModes,
		)
			? latestRenderData?.availableDisplayModes
			: []
		const nextMode =
			mode === 'fullscreen' && displayMode === 'fullscreen' ? 'inline' : mode
		if (!availableDisplayModes.includes(nextMode)) {
			return null
		}
		const resolvedMode = await hostBridge.requestDisplayMode(nextMode)
		return resolvedMode ?? null
	}

	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-shell',
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

	frameElement.addEventListener('load', () => {
		observeRenderedFrameSize()
	})

	globalThis.window.addEventListener('message', (event: MessageEvent) => {
		const childWindow = frameElement.contentWindow
		if (
			event.source === childWindow &&
			isRecord(event.data) &&
			typeof event.data.type === 'string' &&
			event.data.type.startsWith(childMessagePrefix)
		) {
			const payload = isRecord(event.data.payload) ? event.data.payload : {}
			if (event.data.type === `${childMessagePrefix}send-message`) {
				const text = typeof payload.text === 'string' ? payload.text : null
				if (text) {
					void hostBridge.sendUserMessageWithFallback(text)
				}
				return
			}
			if (event.data.type === `${childMessagePrefix}open-link`) {
				const url = typeof payload.url === 'string' ? payload.url : null
				if (url) {
					void hostBridge.openLink(url)
				}
				return
			}
			if (event.data.type === `${childMessagePrefix}request-display-mode`) {
				const requestId =
					typeof payload.requestId === 'string' ? payload.requestId : null
				const mode = coerceDisplayMode(payload.mode)
				if (requestId && mode && event.source) {
					void requestDisplayMode(mode).then((resolvedMode) => {
						;(event.source as WindowProxy).postMessage(
							{
								type: `${childMessagePrefix}display-mode-result`,
								payload: {
									requestId,
									mode: resolvedMode,
								},
							},
							'*',
						)
					})
				}
				return
			}
			if (event.data.type === `${childMessagePrefix}execute-code`) {
				const requestId =
					typeof payload.requestId === 'string' ? payload.requestId : null
				const code = typeof payload.code === 'string' ? payload.code : null
				if (requestId && code && event.source) {
					let didTimeout = false
					const targetWindow = event.source as WindowProxy
					const timeoutId = window.setTimeout(() => {
						didTimeout = true
						targetWindow.postMessage(
							{
								type: `${childMessagePrefix}execute-result`,
								payload: {
									requestId,
									result: null,
									errorMessage: 'Code execution timed out.',
								},
							},
							'*',
						)
					}, 90_000)
					void executeCodeWithHttp(code)
						.then((response) =>
							response.handled
								? response.result
								: executeCodeWithHostTool(hostBridge, code),
						)
						.then((result) => {
							if (didTimeout) return
							window.clearTimeout(timeoutId)
							targetWindow.postMessage(
								{
									type: `${childMessagePrefix}execute-result`,
									payload: {
										requestId,
										result,
										errorMessage: null,
									},
								},
								'*',
							)
						})
						.catch((error) => {
							if (didTimeout) return
							window.clearTimeout(timeoutId)
							targetWindow.postMessage(
								{
									type: `${childMessagePrefix}execute-result`,
									payload: {
										requestId,
										result: null,
										errorMessage:
											error instanceof Error
												? error.message
												: 'Code execution failed.',
									},
								},
								'*',
							)
						})
				}
				return
			}
			if (event.data.type === `${childMessagePrefix}save-secret`) {
				const requestId =
					typeof payload.requestId === 'string' ? payload.requestId : null
				const input = isRecord(payload.input) ? payload.input : null
				if (requestId && input && event.source) {
					void saveSecretWithHttp({
						name: typeof input.name === 'string' ? input.name : '',
						value: typeof input.value === 'string' ? input.value : '',
						description:
							typeof input.description === 'string' ? input.description : '',
						scope: coerceSecretScope(input.scope) ?? undefined,
					}).then((response) => {
						postChildResponse(
							event.source as WindowProxy,
							`${childMessagePrefix}save-secret-result`,
							requestId,
							response,
						)
					})
				}
				return
			}
			if (event.data.type === `${childMessagePrefix}list-secrets`) {
				const requestId =
					typeof payload.requestId === 'string' ? payload.requestId : null
				const input = isRecord(payload.input) ? payload.input : null
				if (requestId && event.source) {
					void listSecretsWithHttp(coerceSecretScope(input?.scope) ?? undefined)
						.then((response) => {
							postChildResponse(
								event.source as WindowProxy,
								`${childMessagePrefix}list-secrets-result`,
								requestId,
								response,
							)
						})
						.catch((error) => {
							postChildResponse(
								event.source as WindowProxy,
								`${childMessagePrefix}list-secrets-result`,
								requestId,
								[],
							)
							console.error(
								'Generated UI list secrets failed:',
								error instanceof Error ? error.message : error,
							)
						})
				}
				return
			}
			if (event.data.type === `${childMessagePrefix}delete-secret`) {
				const requestId =
					typeof payload.requestId === 'string' ? payload.requestId : null
				const input = isRecord(payload.input) ? payload.input : null
				if (requestId && input && event.source) {
					void deleteSecretWithHttp({
						name: typeof input.name === 'string' ? input.name : '',
						scope: coerceSecretScope(input.scope) ?? undefined,
					}).then((response) => {
						postChildResponse(
							event.source as WindowProxy,
							`${childMessagePrefix}delete-secret-result`,
							requestId,
							response,
						)
					})
				}
				return
			}
		}
		hostBridge.handleHostMessage(event.data)
	})

	void hostBridge.initialize()
	hostBridge.requestRenderData()
	void renderEnvelope(null)
}

const documentRef = globalThis.document

if (documentRef?.readyState === 'loading') {
	documentRef.addEventListener('DOMContentLoaded', initializeGeneratedUiShell, {
		once: true,
	})
} else if (documentRef) {
	initializeGeneratedUiShell()
}
