import { type Handle } from 'remix/component'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { colors, mq } from '#client/styles/tokens.ts'
import {
	getAlertCardCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

type SavedUiArtifact = {
	appId: string
	title: string
	description: string
	keywords: Array<string>
	params: Record<string, unknown>
	clientCode: string
	serverCode: string | null
	serverCodeId: string
	appBackend: {
		basePath: string
		facetNames: Array<string>
	} | null
	createdAt: string
	updatedAt: string
	appSession: {
		sessionId: string
		expiresAt: string
		endpoints: {
			source: string
			execute: string
			secrets: string
			deleteSecret: string
		}
		token: string
	} | null
}

type SavedUiStatus = 'loading' | 'ready' | 'error'

const latestProtocolVersion = '2026-01-26'
const initializedNotificationMethod = 'ui/notifications/initialized'
const renderDataType = 'ui-lifecycle-iframe-render-data'
const generatedUiResourceUri = 'ui://generated-ui-runtime/entry-point.html'

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

function getSavedUiApiPath(appId: string) {
	return `/ui-api/${encodeURIComponent(appId)}`
}

function getSavedUiParamsSearchValue() {
	if (typeof window === 'undefined') return null
	return new URL(window.location.href).searchParams.get('params')
}

function readSavedUiParamsFromLocation() {
	const raw = getSavedUiParamsSearchValue()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error(`Invalid saved UI params: ${raw}`)
		}
		return parsed as Record<string, unknown>
	} catch (error) {
		const message =
			error instanceof Error ? error.message : `Invalid saved UI params: ${raw}`
		throw new Error(message)
	}
}

async function loadSavedUi(appId: string) {
	const url = new URL(
		`${getSavedUiApiPath(appId)}/source`,
		window.location.origin,
	)
	const params = readSavedUiParamsFromLocation()
	if (params) {
		url.searchParams.set('params', JSON.stringify(params))
	}
	const response = await fetch(url, {
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
			params?: Record<string, unknown>
			client_code?: string
			server_code?: string | null
			server_code_id?: string
			app_backend?: SavedUiArtifact['appBackend']
			created_at?: string
			updated_at?: string
		}
		appSession?: SavedUiArtifact['appSession']
	} | null
	if (!response.ok || !payload?.ok || !payload.app?.app_id) {
		throw new Error(payload?.error || 'Unable to load saved UI.')
	}
	return {
		appId: payload.app.app_id,
		title: payload.app.title ?? 'Saved UI',
		description: payload.app.description ?? '',
		keywords: [],
		params:
			payload.app.params &&
			typeof payload.app.params === 'object' &&
			!Array.isArray(payload.app.params)
				? payload.app.params
				: {},
		clientCode: payload.app.client_code ?? '',
		serverCode:
			typeof payload.app.server_code === 'string'
				? payload.app.server_code
				: null,
		serverCodeId: payload.app.server_code_id ?? '',
		appBackend:
			payload.app.app_backend &&
			typeof payload.app.app_backend === 'object' &&
			!Array.isArray(payload.app.app_backend) &&
			typeof payload.app.app_backend.basePath === 'string'
				? {
						basePath: payload.app.app_backend.basePath,
						facetNames: Array.isArray(payload.app.app_backend.facetNames)
							? payload.app.app_backend.facetNames.filter(
									(value): value is string => typeof value === 'string',
								)
							: ['main'],
					}
				: null,
		createdAt: payload.app.created_at ?? '',
		updatedAt: payload.app.updated_at ?? '',
		appSession: payload.appSession ?? null,
	} satisfies SavedUiArtifact
}

async function executeSavedUiCode(appId: string, code: string) {
	const response = await fetch(`${getSavedUiApiPath(appId)}/execute`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({ code }),
	})
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		error?: string
		result?: unknown
	} | null
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Code execution failed.')
	}
	return payload.result ?? null
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
	let activeRouteKey: string | null = null
	let loadRequestId = 0

	function update() {
		handle.update()
	}

	function getRouteKey() {
		const appId = getSavedUiIdFromLocation()
		const paramsKey = getSavedUiParamsSearchValue()
		return `${appId ?? ''}?${paramsKey ?? ''}`
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
							params: artifact.params,
							appSession: artifact.appSession,
						},
					},
				},
			},
			savedUiShellOrigin,
		)
	}

	async function refreshArtifact() {
		const appId = getSavedUiIdFromLocation()
		const routeKey = getRouteKey()
		if (!appId) {
			status = 'error'
			errorMessage = 'Saved UI not found.'
			artifact = null
			update()
			return
		}
		activeRouteKey = routeKey
		status = 'loading'
		errorMessage = null
		artifact = null
		shellInitialized = false
		latestShellWindow = null
		update()
		const requestId = ++loadRequestId
		try {
			const nextArtifact = await loadSavedUi(appId)
			if (requestId !== loadRequestId || getRouteKey() !== routeKey) {
				return
			}
			artifact = nextArtifact
			status = 'ready'
			errorMessage = null
			update()
			postRenderDataIfReady()
		} catch (error) {
			if (requestId !== loadRequestId || getRouteKey() !== routeKey) {
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
		const nextRouteKey = getRouteKey()
		if (!getSavedUiIdFromLocation()) {
			activeRouteKey = null
			return
		}
		if (nextRouteKey === activeRouteKey) return
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

			if (
				(message as { method?: unknown }).method !== 'tools/call' ||
				!latestShellWindow
			) {
				return
			}

			const toolName = (message as { params?: { name?: unknown } }).params?.name
			const respond = (result: Record<string, unknown>) => {
				latestShellWindow?.postMessage(
					{
						jsonrpc: '2.0',
						id: (message as { id?: unknown }).id,
						result,
					},
					savedUiShellOrigin,
				)
			}

			if (toolName === 'ui_load_app_source') {
				if (status !== 'ready' || !artifact) {
					respond({
						isError: true,
						structuredContent: {
							error: { message: 'Saved UI is not ready yet.' },
						},
					})
					return
				}
				respond({
					structuredContent: {
						app_id: artifact.appId,
						title: artifact.title,
						description: artifact.description,
						params: artifact.params,
						client_code: artifact.clientCode,
						server_code: artifact.serverCode,
						server_code_id: artifact.serverCodeId,
						app_backend: artifact.appBackend,
					},
				})
				return
			}

			if (toolName === 'execute') {
				const code = (
					message as {
						params?: { arguments?: { code?: unknown } }
					}
				).params?.arguments?.code
				const targetAppId = status === 'ready' ? artifact?.appId : null
				if (typeof code !== 'string' || !code.trim() || !targetAppId) {
					respond({
						isError: true,
						structuredContent: { error: { message: 'Code is required.' } },
					})
					return
				}
				// Respond via microtask/async continuation — not handle.queueTask. Deferring
				// through the Remix scheduler can land after the widget bridge request timeout
				// (default 1500ms), so tools/call would fail with a null result in the shell.
				void (async () => {
					try {
						const result = await executeSavedUiCode(targetAppId, code)
						respond({ structuredContent: { result } })
					} catch (error) {
						respond({
							isError: true,
							structuredContent: {
								error: {
									message:
										error instanceof Error
											? error.message
											: 'Tool call failed.',
								},
							},
						})
					}
				})()
				return
			}

			respond({
				isError: true,
				structuredContent: {
					error: { message: 'Unsupported tool call.' },
				},
			})
		},
	})

	return () => {
		return (
			<section
				css={{
					...stackedPageCss,
					minHeight: 'calc(100vh - 7rem)',
				}}
			>
				<header css={pageHeaderCss}>
					<h1 css={pageTitleCss}>
						{status === 'ready' ? (artifact?.title ?? 'Saved UI') : 'Saved UI'}
					</h1>
					<p css={pageDescriptionCss}>
						Hosted fallback for a saved generated UI.
					</p>
				</header>
				{status === 'loading' ? (
					<p css={pageDescriptionCss}>Loading saved UI...</p>
				) : null}
				{errorMessage ? (
					<p role="alert" css={getAlertCardCss('error')}>
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
