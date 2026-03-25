import { type Handle } from 'remix/component'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'

type SavedUiArtifact = {
	appId: string
	title: string
	description: string
}

type SavedUiStatus = 'loading' | 'ready' | 'error'

const latestProtocolVersion = '2026-01-26'
const initializedNotificationMethod = 'ui/notifications/initialized'
const renderDataType = 'ui-lifecycle-iframe-render-data'
const generatedUiResourceUri = 'ui://generated-ui-shell/entry-point.html'

function getSavedUiIdFromLocation() {
	if (typeof window === 'undefined') return null
	const prefix = '/ui/'
	if (!window.location.pathname.startsWith(prefix)) return null
	const path = window.location.pathname.slice(prefix.length)
	const [id] = path.split('/')
	const trimmed = id?.trim()
	if (!trimmed) return null
	try {
		return decodeURIComponent(trimmed)
	} catch {
		return null
	}
}

function getSavedUiApiBasePath(appId: string) {
	return `/ui-api/${encodeURIComponent(appId)}`
}

async function loadSavedUi(appId: string) {
	const response = await fetch(`${getSavedUiApiBasePath(appId)}/source`, {
		credentials: 'include',
		headers: { Accept: 'application/json' },
	})
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		error?: string
		app?: {
			app_id?: string
			title?: string
			description?: string
		}
	} | null
	if (!response.ok || !payload?.ok || !payload.app?.app_id) {
		throw new Error(payload?.error || 'Unable to load saved UI.')
	}
	return {
		appId: payload.app.app_id,
		title: payload.app.title ?? 'Saved UI',
		description: payload.app.description ?? '',
	}
}

function getTextContent(content: unknown) {
	if (!Array.isArray(content)) return null
	const entry = content[0]
	if (!entry || typeof entry !== 'object') return null
	return (entry as { type?: unknown }).type === 'text' &&
		typeof (entry as { text?: unknown }).text === 'string'
		? (entry as { text: string }).text
		: null
}

export function SavedUiRoute(handle: Handle) {
	const savedUiShellOrigin =
		typeof window === 'undefined'
			? null
			: new URL('/dev/generated-ui', window.location.href).origin
	let status: SavedUiStatus = 'loading'
	let errorMessage: string | null = null
	let artifact: SavedUiArtifact | null = null
	let shellInitialized = false
	let latestShellWindow: Window | null = null
	let activeAppId: string | null = null
	let loadRequestId = 0

	function update() {
		handle.update()
	}

	function postRenderDataIfReady() {
		if (
			!shellInitialized ||
			!latestShellWindow ||
			!artifact ||
			!savedUiShellOrigin
		) {
			return
		}
		latestShellWindow.postMessage(
			{
				type: renderDataType,
				payload: {
					renderData: {
						theme: 'light',
						displayMode: 'inline',
						availableDisplayModes: ['inline'],
						toolOutput: {
							widget: 'generated_ui',
							resourceUri: generatedUiResourceUri,
							renderSource: 'saved_app',
							appId: artifact.appId,
							title: artifact.title,
							description: artifact.description,
						},
					},
				},
			},
			savedUiShellOrigin,
		)
	}

	async function refreshArtifact() {
		const appId = getSavedUiIdFromLocation()
		if (!appId) {
			status = 'error'
			errorMessage = 'Saved UI not found.'
			artifact = null
			update()
			return
		}
		activeAppId = appId
		status = 'loading'
		errorMessage = null
		artifact = null
		shellInitialized = false
		latestShellWindow = null
		update()
		const requestId = ++loadRequestId
		try {
			const nextArtifact = await loadSavedUi(appId)
			if (requestId !== loadRequestId || getSavedUiIdFromLocation() !== appId) {
				return
			}
			artifact = nextArtifact
			status = 'ready'
			errorMessage = null
			update()
			postRenderDataIfReady()
		} catch (error) {
			if (requestId !== loadRequestId || getSavedUiIdFromLocation() !== appId) {
				return
			}
			status = 'error'
			errorMessage =
				error instanceof Error ? error.message : 'Unable to load saved UI.'
			artifact = null
			shellInitialized = false
			latestShellWindow = null
			update()
		}
	}

	handle.queueTask(refreshArtifact)

	listenToRouterNavigation(handle, () => {
		const nextAppId = getSavedUiIdFromLocation()
		if (!nextAppId) {
			activeAppId = null
			return
		}
		if (nextAppId === activeAppId) return
		handle.queueTask(refreshArtifact)
	})

	handle.on(window, {
		message: (event: MessageEvent) => {
			const frameElement = document.querySelector<HTMLIFrameElement>(
				'[data-saved-ui-shell]',
			)
			if (
				!frameElement ||
				!savedUiShellOrigin ||
				event.source !== frameElement.contentWindow ||
				event.origin !== savedUiShellOrigin
			) {
				return
			}
			latestShellWindow = frameElement.contentWindow
			const message = event.data
			if (!message || typeof message !== 'object') return

			if ((message as { type?: unknown }).type === 'ui-request-render-data') {
				postRenderDataIfReady()
				return
			}

			if ((message as { jsonrpc?: unknown }).jsonrpc !== '2.0') return

			if (
				(message as { method?: unknown }).method === 'ui/initialize' &&
				latestShellWindow
			) {
				shellInitialized = true
				latestShellWindow.postMessage(
					{
						jsonrpc: '2.0',
						id: (message as { id?: unknown }).id,
						result: {
							protocolVersion: latestProtocolVersion,
							hostInfo: { name: 'kody-web-host', version: '1.0.0' },
							hostCapabilities: {
								message: { text: {} },
								openLinks: {},
								serverTools: { listChanged: false },
							},
							hostContext: {
								theme: 'light',
								displayMode: 'inline',
								availableDisplayModes: ['inline'],
							},
						},
					},
					savedUiShellOrigin,
				)
				latestShellWindow.postMessage(
					{
						jsonrpc: '2.0',
						method: initializedNotificationMethod,
						params: {},
					},
					savedUiShellOrigin,
				)
				postRenderDataIfReady()
				return
			}

			if (
				(message as { method?: unknown }).method === 'ui/message' &&
				latestShellWindow
			) {
				const text = getTextContent(
					(message as { params?: { content?: unknown } }).params?.content,
				)
				latestShellWindow.postMessage(
					{
						jsonrpc: '2.0',
						id: (message as { id?: unknown }).id,
						result: text ? {} : { isError: true },
					},
					savedUiShellOrigin,
				)
				return
			}

			if (
				(message as { method?: unknown }).method === 'ui/open-link' &&
				latestShellWindow
			) {
				const url = (message as { params?: { url?: unknown } }).params?.url
				if (typeof url === 'string' && url) {
					window.open(url, '_blank', 'noopener,noreferrer')
				}
				latestShellWindow.postMessage(
					{
						jsonrpc: '2.0',
						id: (message as { id?: unknown }).id,
						result: {},
					},
					savedUiShellOrigin,
				)
				return
			}

			if (
				(message as { method?: unknown }).method ===
					'ui/request-display-mode' &&
				latestShellWindow
			) {
				latestShellWindow.postMessage(
					{
						jsonrpc: '2.0',
						id: (message as { id?: unknown }).id,
						result: { mode: 'inline' },
					},
					savedUiShellOrigin,
				)
				return
			}
		},
	})

	return () => {
		return (
			<section
				css={{
					display: 'grid',
					gap: spacing.lg,
					minHeight: 'calc(100vh - 7rem)',
				}}
			>
				<header css={{ display: 'grid', gap: spacing.xs }}>
					<h1
						css={{
							margin: 0,
							color: colors.text,
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
						}}
					>
						{status === 'ready' ? (artifact?.title ?? 'Saved UI') : 'Saved UI'}
					</h1>
					<p css={{ margin: 0, color: colors.textMuted }}>
						Hosted fallback for a saved generated UI.
					</p>
				</header>
				{status === 'loading' ? (
					<p css={{ margin: 0, color: colors.textMuted }}>
						Loading saved UI...
					</p>
				) : null}
				{errorMessage ? (
					<p
						role="alert"
						css={{
							margin: 0,
							padding: `${spacing.sm} ${spacing.md}`,
							borderRadius: '0.75rem',
							border: `1px solid ${colors.error}`,
							color: colors.error,
							backgroundColor: colors.surface,
						}}
					>
						{errorMessage}
					</p>
				) : null}
				{status === 'ready' ? (
					<iframe
						data-saved-ui-shell
						title="Saved UI"
						src="/dev/generated-ui"
						css={{
							width: '100%',
							minHeight: '70vh',
							border: `1px solid ${colors.border}`,
							borderRadius: '1rem',
							backgroundColor: 'transparent',
							[mq.mobile]: {
								minHeight: '60vh',
							},
						}}
					/>
				) : null}
			</section>
		)
	}
}
