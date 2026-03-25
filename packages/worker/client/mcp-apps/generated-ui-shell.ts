import { createWidgetHostBridge } from './widget-host-bridge.js'

type RenderMode = 'inline_code' | 'saved_app'
type AppRuntime = 'html' | 'javascript'
type DisplayMode = 'inline' | 'fullscreen' | 'pip'
type ThemeName = 'light' | 'dark'

type RenderEnvelope = {
	mode: RenderMode
	code?: string
	appId?: string
	runtime?: AppRuntime
}

type RenderDataEnvelope = {
	toolOutput?: Record<string, unknown>
	theme?: string
	displayMode?: string
	availableDisplayModes?: Array<string>
}

type HostToolResult = {
	structuredContent?: unknown
	isError?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function coerceRuntime(value: unknown): AppRuntime | undefined {
	return value === 'html' || value === 'javascript' ? value : undefined
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
			? code.replace(
					/<html\b[^>]*>/i,
					(match) => injectThemeAttributeIntoHtmlTag(match, theme),
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
	return { mode: renderSource, code, appId, runtime }
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

	function getBaseHref() {
		try {
			return new URL('/', import.meta.url).toString()
		} catch {
			return null
		}
	}

	function escapeInlineModuleSource(code: string) {
		return code.replace(/<\/script/gi, '<\\/script')
	}

	function escapeHtmlAttribute(value: string) {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('"', '&quot;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
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
		const baseHref = getBaseHref()
		const escapedBaseHref = baseHref ? escapeHtmlAttribute(baseHref) : null
		return `
${escapedBaseHref ? `<base href="${escapedBaseHref}" />` : ''}
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
		frameElement.srcdoc = htmlSource
	}

	async function resolveSavedAppCode(appId: string) {
		const result = (await hostBridge.callTool({
			name: 'ui_load_app_source',
			arguments: { app_id: appId },
		})) as HostToolResult | null
		if (!result || result.isError) {
			throw new Error('Failed to load saved app source.')
		}
		const structuredContent = isRecord(result.structuredContent)
			? result.structuredContent
			: null
		const code =
			structuredContent && typeof structuredContent.code === 'string'
				? structuredContent.code
				: null
		if (!code) {
			throw new Error('Saved app source is missing code.')
		}
		return {
			code,
			runtime: coerceRuntime(structuredContent?.runtime) ?? 'html',
		}
	}

	async function renderEnvelope(envelope: RenderEnvelope | null) {
		if (!envelope) {
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
			setFrameSource(resolved.code, resolved.runtime)
		} catch (error) {
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

	globalThis.window.addEventListener('message', (event: MessageEvent) => {
		if (
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
					void hostBridge
						.callTool({
							name: 'execute',
							arguments: { code },
						})
						.then((result) => {
							const errorMessage = getHostToolErrorMessage(result)
							const structuredContent = isRecord(result?.structuredContent)
								? result.structuredContent
								: null
							;(event.source as WindowProxy).postMessage(
								{
									type: `${childMessagePrefix}execute-result`,
									payload: {
										requestId,
										result:
											result?.isError === true
												? null
												: (structuredContent?.result ?? null),
										errorMessage,
									},
								},
								'*',
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
