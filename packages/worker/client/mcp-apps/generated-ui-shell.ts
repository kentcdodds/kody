import { createWidgetHostBridge } from './widget-host-bridge.js'

type RenderMode = 'inline_code' | 'saved_app'

type RenderEnvelope = {
	mode: RenderMode
	code?: string
	appId?: string
	title?: string
	description?: string
}

type RenderDataEnvelope = {
	toolInput?: Record<string, unknown>
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

function readTheme(source: Record<string, unknown> | undefined) {
	const theme = source?.theme
	return theme === 'dark' || theme === 'light' ? theme : undefined
}

function coerceRenderEnvelope(value: unknown): RenderEnvelope | null {
	if (!isRecord(value)) return null
	const renderSource = value.renderSource ?? value.mode
	if (renderSource !== 'inline_code' && renderSource !== 'saved_app')
		return null
	let code: string | undefined
	const source = isRecord(value.source) ? value.source : null
	if (typeof value.code === 'string') {
		code = value.code
	} else if (typeof value.sourceCode === 'string') {
		code = value.sourceCode
	} else if (source && typeof source.entrypoint === 'string') {
		code = source.entrypoint
	}
	const appId = typeof value.appId === 'string' ? value.appId : undefined
	const title = typeof value.title === 'string' ? value.title : undefined
	const description =
		typeof value.description === 'string' ? value.description : undefined
	return { mode: renderSource, code, appId, title, description }
}

function getEnvelopeFromRenderData(renderData: RenderDataEnvelope | undefined) {
	const toolOutput = isRecord(renderData?.toolOutput)
		? renderData.toolOutput
		: undefined
	return (
		coerceRenderEnvelope(toolOutput?.render) ??
		coerceRenderEnvelope(toolOutput) ??
		null
	)
}

function initializeGeneratedUiShell() {
	const documentRef = globalThis.document
	const windowRef = globalThis.window
	if (!documentRef || !windowRef) return

	const rootElement = documentRef.documentElement
	const frameElementMaybe = documentRef.querySelector<HTMLIFrameElement>(
		'[data-generated-ui-frame]',
	)
	const titleElementMaybe = documentRef.querySelector<HTMLElement>(
		'[data-generated-ui-title]',
	)
	const descriptionElementMaybe = documentRef.querySelector<HTMLElement>(
		'[data-generated-ui-description]',
	)
	const statusElementMaybe = documentRef.querySelector<HTMLElement>(
		'[data-generated-ui-status]',
	)
	const errorElementMaybe = documentRef.querySelector<HTMLElement>(
		'[data-generated-ui-error]',
	)
	const fullscreenButton = documentRef.querySelector<HTMLButtonElement>(
		'[data-action="toggle-fullscreen"]',
	)
	const openLinkButton = documentRef.querySelector<HTMLButtonElement>(
		'[data-action="open-link"]',
	)

	if (
		!frameElementMaybe ||
		!titleElementMaybe ||
		!descriptionElementMaybe ||
		!statusElementMaybe ||
		!errorElementMaybe ||
		!fullscreenButton ||
		!openLinkButton
	) {
		return
	}
	const frameElement = frameElementMaybe
	const titleElement = titleElementMaybe
	const descriptionElement = descriptionElementMaybe
	const statusElement = statusElementMaybe
	const errorElement = errorElementMaybe
	const childMessagePrefix = 'kody-generated-ui:'

	let latestRenderData: RenderDataEnvelope | undefined
	let currentEnvelope: RenderEnvelope | null = null
	let currentFrameUrl: string | null = null

	function applyTheme(theme: string | undefined) {
		if (theme === 'dark' || theme === 'light') {
			rootElement.setAttribute('data-theme', theme)
			return
		}
		rootElement.removeAttribute('data-theme')
	}

	function setStatus(text: string) {
		statusElement.textContent = text
	}

	function setError(message: string | null) {
		errorElement.textContent = message ?? ''
		errorElement.hidden = message == null
	}

	function setTitleAndDescription(input: {
		title?: string
		description?: string
	}) {
		titleElement.textContent = input.title ?? 'Generated UI'
		descriptionElement.textContent =
			input.description ??
			'This shell renders inline generated code or a saved app artifact.'
	}

	function buildInlineModuleSource(code: string) {
		return `
const shellRootElement = document.getElementById('app')
window.kodyWidget = {
	sendMessage(text) {
		if (window.parent === window) return undefined
		window.parent.postMessage({
			type: '${childMessagePrefix}send-message',
			payload: { text },
		}, '*')
		return true
	},
	openLink(url) {
		if (window.parent === window) return undefined
		window.parent.postMessage({
			type: '${childMessagePrefix}open-link',
			payload: { url },
		}, '*')
		return true
	},
	async toggleFullscreen() {
		if (window.parent === window) return 'inline'
		window.parent.postMessage({
			type: '${childMessagePrefix}toggle-fullscreen',
			payload: {},
		}, '*')
		return 'fullscreen'
	},
}
${code}
		`.trim()
	}

	function setFrameSource(code: string) {
		const previousFrameUrl = currentFrameUrl
		const inlineModuleSource = buildInlineModuleSource(code)
		const shellHtml = `
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
		<pre id="app-error" hidden></pre>
		<script>
			window.addEventListener('error', (event) => {
				const target = document.getElementById('app-error');
				if (!target) return;
				target.hidden = false;
				target.textContent = String(event.error?.message ?? event.message ?? event.error ?? 'Unknown inline app error');
			});
			window.addEventListener('unhandledrejection', (event) => {
				const target = document.getElementById('app-error');
				if (!target) return;
				target.hidden = false;
				target.textContent = String(event.reason?.message ?? event.reason ?? 'Unknown inline app rejection');
			});
		</script>
		<script type="module">
${inlineModuleSource}
		</script>
	</body>
</html>
		`.trim()
		const htmlBlob = new Blob([shellHtml], { type: 'text/html' })
		const htmlUrl = URL.createObjectURL(htmlBlob)
		currentFrameUrl = htmlUrl
		frameElement.src = htmlUrl
		if (previousFrameUrl) {
			URL.revokeObjectURL(previousFrameUrl)
		}
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
		const title =
			structuredContent && typeof structuredContent.title === 'string'
				? structuredContent.title
				: undefined
		const description =
			structuredContent && typeof structuredContent.description === 'string'
				? structuredContent.description
				: undefined
		return { code, title, description }
	}

	async function renderEnvelope(envelope: RenderEnvelope | null) {
		currentEnvelope = envelope
		if (!envelope) {
			setTitleAndDescription({})
			setStatus('Waiting for render data from the host.')
			setError(null)
			frameElement.removeAttribute('src')
			return
		}

		setTitleAndDescription({
			title: envelope.title,
			description: envelope.description,
		})
		setError(null)

		if (envelope.mode === 'inline_code') {
			if (!envelope.code) {
				setStatus('Unable to render inline code.')
				setError('The tool result did not include inline code.')
				return
			}
			setFrameSource(envelope.code)
			setStatus('Rendering inline generated app.')
			return
		}

		if (!envelope.appId) {
			setStatus('Unable to load saved app.')
			setError('The tool result did not include an app_id.')
			return
		}

		setStatus('Loading saved app.')
		try {
			const resolved = await resolveSavedAppCode(envelope.appId)
			setTitleAndDescription({
				title: resolved.title ?? envelope.title,
				description: resolved.description ?? envelope.description,
			})
			setFrameSource(resolved.code)
			setStatus('Rendering saved app.')
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unknown app loading error.'
			setStatus('Failed to load saved app.')
			setError(message)
		}
	}

	async function toggleFullscreen() {
		const displayMode = latestRenderData?.displayMode
		const availableDisplayModes = Array.isArray(
			latestRenderData?.availableDisplayModes,
		)
			? latestRenderData?.availableDisplayModes
			: []
		const nextMode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen'
		if (!availableDisplayModes.includes(nextMode)) {
			setStatus(`Display mode "${nextMode}" is not available in this host.`)
			return
		}
		const resolvedMode = await hostBridge.requestDisplayMode(nextMode)
		if (!resolvedMode) {
			setStatus('The host rejected the display mode change.')
			return
		}
		setStatus(`Display mode changed to ${resolvedMode}.`)
	}

	async function openArtifactPage() {
		const appId = currentEnvelope?.appId
		if (!appId) {
			setStatus('No saved app is active to inspect.')
			return
		}
		const url = new URL(`/app/generated-ui/${appId}`, windowRef.location.origin)
		const opened = await hostBridge.openLink(url.toString())
		setStatus(
			opened
				? 'Requested that the host open the saved app link.'
				: 'The host rejected the open-link request.',
		)
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
			applyTheme(readTheme(nextRenderData))
			void renderEnvelope(getEnvelopeFromRenderData(nextRenderData))
		},
		onHostContextChanged: (hostContext) => {
			applyTheme(readTheme(hostContext))
			if (isRecord(hostContext)) {
				latestRenderData = {
					...latestRenderData,
					...hostContext,
				}
			}
		},
	})

	fullscreenButton.addEventListener('click', () => {
		void toggleFullscreen()
	})
	openLinkButton.addEventListener('click', () => {
		void openArtifactPage()
	})

	windowRef.addEventListener('message', (event) => {
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
			if (event.data.type === `${childMessagePrefix}toggle-fullscreen`) {
				void toggleFullscreen()
				return
			}
		}
		hostBridge.handleHostMessage(event.data)
	})
	windowRef.addEventListener('beforeunload', () => {
		if (currentFrameUrl) {
			URL.revokeObjectURL(currentFrameUrl)
			currentFrameUrl = null
		}
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
