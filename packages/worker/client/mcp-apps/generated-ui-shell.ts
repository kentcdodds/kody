import { createWidgetHostBridge } from './widget-host-bridge.js'

type RenderMode = 'inline_code' | 'saved_app'
type AppRuntime = 'html' | 'javascript'
type DisplayMode = 'inline' | 'fullscreen' | 'pip'

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
	async callTool(name, args) {
		if (window.parent === window) return null;
		const requestId = nextRequestId();
		const payload = await postRequestAndWaitForShellMessage(
			shellMessagePrefix + 'call-tool',
			{
				requestId,
				name,
				arguments: args && typeof args === 'object' ? args : undefined,
			},
			shellMessagePrefix + 'tool-result',
			requestId,
		);
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
		const baseHref = getBaseHref()
		const escapedBaseHref = baseHref ? escapeInlineModuleSource(baseHref) : null
		return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${escapedBaseHref ? `<base href="${escapedBaseHref}" />` : ''}
		<script>
${buildChildBridgeRuntimeSource()}
		</script>
	</head>
	<body>
${code}
	</body>
</html>
		`.trim()
	}

	function injectIntoHtmlDocument(code: string) {
		const baseHref = getBaseHref()
		const injection = `
${baseHref ? `<base href="${baseHref}" />` : ''}
<script>
${buildChildBridgeRuntimeSource()}
</script>
		`.trim()
		if (/<head[\s>]/i.test(code)) {
			return code.replace(/<head([\s>]*)/i, `<head$1>\n${injection}\n`)
		}
		if (/<html[\s>]/i.test(code)) {
			return code.replace(/<html([\s>])/i, `<html$1><head>${injection}</head>`)
		}
		if (/<\/body>/i.test(code)) {
			return code.replace(/<\/body>/i, `${injection}\n</body>`)
		}
		return `${injection}\n${code}`
	}

	function setFrameSource(code: string, runtime: AppRuntime) {
		if (runtime === 'javascript') {
			const inlineModuleSource = buildInlineModuleSource(code)
			frameElement.srcdoc = `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<style>
			html, body {
				margin: 0;
				padding: 0;
				min-height: 100%;
				background: transparent;
			}
		</style>
	</head>
	<body>
		<div id="app" data-generated-ui-root></div>
		<script type="module">
${inlineModuleSource}
		</script>
	</body>
</html>
			`.trim()
			return
		}

		const htmlSource = /<(?:!doctype|html|head|body)\b/i.test(code)
			? injectIntoHtmlDocument(code)
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
			if (event.data.type === `${childMessagePrefix}call-tool`) {
				const requestId =
					typeof payload.requestId === 'string' ? payload.requestId : null
				const name = typeof payload.name === 'string' ? payload.name : null
				const argumentsValue = isRecord(payload.arguments)
					? payload.arguments
					: undefined
				if (requestId && name && event.source) {
					void hostBridge
						.callTool({
							name,
							...(argumentsValue ? { arguments: argumentsValue } : {}),
						})
						.then((result) => {
							;(event.source as WindowProxy).postMessage(
								{
									type: `${childMessagePrefix}tool-result`,
									payload: {
										requestId,
										result,
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

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initializeGeneratedUiShell, {
		once: true,
	})
} else {
	initializeGeneratedUiShell()
}
