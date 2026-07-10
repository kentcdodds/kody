import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import toggle from 'remix/ui/toggle'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementShell,
	AccountManagementSidebar,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
} from '#client/styles/style-primitives.ts'
import { writeClipboardText } from '#client/clipboard.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { userScopedConnectorWebSocketUrl } from '@kody-internal/shared/remote-connectors.ts'

type RemoteConnectorListItem = {
	id: string
	instanceId: string
	connectorUrl: string
	enabled: boolean
	attached: boolean
	hasSharedSecret: boolean
	sharedSecret: string
	createdAt: string
	updatedAt: string
}

type AccountRemoteConnectorsPayload = {
	ok: true
	email: string
	username: string
	connectorUrlOrigin: string
	connectors: Array<RemoteConnectorListItem>
	selectedConnectorId?: string
}

type EditorState = {
	id: string | null
	instanceId: string
	enabled: boolean
	attached: boolean
	sharedSecret: string
	hasSharedSecret: boolean
}

const accountRemoteConnectorsApiPath = '/account/remote-connectors.json'
const accountRemoteConnectorsPath = '/account/remote-connectors'
const generatedSecretBytes = 32

function isAccountRemoteConnectorsPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname === accountRemoteConnectorsPath
	)
}

export async function accountRemoteConnectorsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(accountRemoteConnectorsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountRemoteConnectorsPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load remote connector settings.')
	}
	return { accountRemoteConnectors: payload }
}

function createEmptyEditorState(): EditorState {
	return {
		id: null,
		instanceId: '',
		enabled: true,
		attached: true,
		sharedSecret: '',
		hasSharedSecret: false,
	}
}

function createEditorStateFromConnector(
	connector: RemoteConnectorListItem,
): EditorState {
	return {
		id: connector.id,
		instanceId: connector.instanceId,
		enabled: connector.enabled,
		attached: connector.attached,
		sharedSecret: connector.sharedSecret,
		hasSharedSecret: connector.hasSharedSecret,
	}
}

function connectorLabel(
	connector: Pick<RemoteConnectorListItem, 'instanceId'>,
) {
	return connector.instanceId
}

function generateSharedSecret() {
	const bytes = new Uint8Array(generatedSecretBytes)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

function ClipboardIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</svg>
	)
}

function CheckIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	)
}

function EyeIcon(props: { showSecret: boolean }) {
	return props.showSecret ? (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
			<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
			<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
			<line x1="2" x2="22" y1="2" y2="22" />
		</svg>
	) : (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	)
}

function CopyToClipboard(handle: Handle<{ url: string }>) {
	let state: 'idle' | 'copied' | 'error' = 'idle'

	return () => {
		const label =
			state === 'idle'
				? 'Copy connector URL'
				: state === 'copied'
					? 'Copied connector URL'
					: 'Could not copy connector URL'

		return (
			<button
				type="button"
				aria-label={label}
				aria-live="polite"
				mix={[
					on('click', async (_event, signal) => {
						try {
							await writeClipboardText(handle.props.url)
							if (signal.aborted) return
						} catch {
							state = 'error'
							await handle.update()
							return
						}

						state = 'copied'
						await handle.update()
						setTimeout(() => {
							if (signal.aborted) return
							state = 'idle'
							handle.update()
						}, 2000)
					}),
					css({
						...getSecondaryButtonCss(),
						display: 'inline-flex',
						alignItems: 'center',
						gap: spacing.xs,
						whiteSpace: 'nowrap',
					}),
				]}
			>
				{state === 'copied' ? CheckIcon() : ClipboardIcon()}
				{state === 'copied' ? 'Copied' : state === 'error' ? 'Error' : 'Copy'}
			</button>
		)
	}
}

const iconButtonCss = {
	position: 'absolute' as const,
	right: spacing.sm,
	top: '50%',
	transform: 'translateY(-50%)',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2rem',
	height: '2rem',
	padding: 0,
	border: 'none',
	borderRadius: radius.full,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	boxShadow: 'none',
	'&:hover': {
		color: colors.text,
		backgroundColor: colors.primarySoftest,
	},
	'&:disabled': {
		cursor: 'not-allowed',
		opacity: 0.5,
	},
}

export function AccountRemoteConnectorsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveState: 'idle' | 'saving' | 'deleting' = 'idle'
	let username = ''
	let connectorUrlOrigin = ''
	let connectors: Array<RemoteConnectorListItem> = []
	let editorState = createEmptyEditorState()
	let message: string | null = null
	const loadLatch = createRouteLoadLatch()
	let deleteConfirm = false
	let showSharedSecret = false

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	async function loadRemoteConnectors(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(accountRemoteConnectorsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountRemoteConnectorsPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load remote connector settings.')
			}
			applyPayload(payload)
			status = 'ready'
			message = null
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load remote connector settings.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyPayload(payload: AccountRemoteConnectorsPayload) {
		username = payload.username
		connectorUrlOrigin = payload.connectorUrlOrigin
		connectors = payload.connectors
		deleteConfirm = false
		if (payload.selectedConnectorId) {
			const selected = connectors.find(
				(connector) => connector.id === payload.selectedConnectorId,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
			showSharedSecret = false
			return
		}
		if (editorState.id) {
			const selected = connectors.find(
				(connector) => connector.id === editorState.id,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
			showSharedSecret = false
		}
	}

	function readEditorStateFromForm(form: HTMLFormElement) {
		const formData = new FormData(form)
		const enabled = formData.get('enabled') === 'on'
		return {
			...editorState,
			instanceId: String(formData.get('instanceId') ?? '').trim(),
			sharedSecret: String(formData.get('sharedSecret') ?? ''),
			enabled,
			attached: enabled
				? formData.get('attached') === 'on'
				: editorState.attached,
		} satisfies EditorState
	}

	async function saveConnector(form?: HTMLFormElement) {
		if (saveState !== 'idle') return
		const nextEditorState = form ? readEditorStateFromForm(form) : editorState
		editorState = nextEditorState
		if (!nextEditorState.instanceId.trim()) {
			message = 'Connector name is required.'
			handle.update()
			return
		}
		if (
			!nextEditorState.hasSharedSecret &&
			!nextEditorState.sharedSecret.trim()
		) {
			message = 'Connector shared secret is required.'
			handle.update()
			return
		}
		const wasEditing = Boolean(editorState.id)
		saveState = 'saving'
		message = null
		handle.update()
		try {
			const response = await fetch(accountRemoteConnectorsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'save',
					id: nextEditorState.id,
					instanceId: nextEditorState.instanceId,
					enabled: nextEditorState.enabled,
					attached: nextEditorState.attached,
					sharedSecret: nextEditorState.sharedSecret,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountRemoteConnectorsPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save remote connector.')
			}
			applyPayload(payload)
			saveState = 'idle'
			message = wasEditing
				? 'Saved remote connector.'
				: 'Created remote connector.'
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error
					? error.message
					: 'Unable to save remote connector.'
			handle.update()
		}
	}

	async function deleteConnector() {
		if (!editorState.id || saveState !== 'idle') return
		saveState = 'deleting'
		message = null
		handle.update()
		try {
			const response = await fetch(accountRemoteConnectorsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'delete',
					id: editorState.id,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountRemoteConnectorsPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete remote connector.')
			}
			applyPayload(payload)
			editorState = createEmptyEditorState()
			deleteConfirm = false
			saveState = 'idle'
			message = 'Deleted remote connector.'
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error
					? error.message
					: 'Unable to delete remote connector.'
			handle.update()
		}
	}

	function selectConnector(connector: RemoteConnectorListItem) {
		if (saveState !== 'idle') return
		editorState = createEditorStateFromConnector(connector)
		deleteConfirm = false
		showSharedSecret = false
		message = null
		handle.update()
	}

	function startNewConnector() {
		editorState = createEmptyEditorState()
		deleteConfirm = false
		showSharedSecret = false
		message = null
		handle.update()
	}

	function setSharedSecret(value: string) {
		editorState = {
			...editorState,
			sharedSecret: value,
		}
	}

	function generateConnectorSecret() {
		setSharedSecret(generateSharedSecret())
		showSharedSecret = true
		message = null
		handle.update()
	}

	function getEditorConnectorUrl() {
		if (!username || !connectorUrlOrigin) return null
		if (!editorState.instanceId.trim()) return null
		return userScopedConnectorWebSocketUrl({
			origin: connectorUrlOrigin,
			username,
			instanceId: editorState.instanceId,
		})
	}

	function applyRouteLoaderData(href: string) {
		if (!isAccountRemoteConnectorsPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountRemoteConnectors',
			href,
		)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		message = null
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadRemoteConnectors)
		}
		const isMutating = saveState !== 'idle'
		const isEditing = Boolean(editorState.id)
		const selectedLabel = editorState.instanceId
			? editorState.instanceId
			: 'New remote connector'
		const connectorUrl = getEditorConnectorUrl()

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Remote connectors"
					description="Attach connector refs to normal Kody sessions and manage the shared secrets used by connector hello authentication."
					currentHref={currentHref}
					actions={
						<button
							type="button"
							disabled={isMutating}
							mix={[on('click', startNewConnector), css(primaryButtonCss)]}
						>
							New connector
						</button>
					}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading remote connectors...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<AccountManagementLayout
						sidebarWidth="minmax(18rem, 24rem)"
						sidebar={
							<AccountManagementSidebar
								title="Configured connectors"
								description="Enabled and attached entries are included in your standard MCP and chat caller context."
							>
								{connectors.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No remote connectors yet. Create one to get started.
									</p>
								) : (
									<AccountManagementList>
										{connectors.map((connector) => (
											<li key={connector.id}>
												<AccountManagementListItemButton
													active={editorState.id === connector.id}
													disabled={isMutating}
													onClick={() => selectConnector(connector)}
												>
													<strong>{connectorLabel(connector)}</strong>
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														{connector.enabled ? 'Enabled' : 'Disabled'} ·{' '}
														{connector.attached ? 'Attached' : 'Not attached'} ·{' '}
														{connector.hasSharedSecret
															? 'Secret saved'
															: 'Missing secret'}
													</span>
												</AccountManagementListItemButton>
											</li>
										))}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						<form
							method="post"
							noValidate
							mix={[
								on('submit', (event) => {
									event.preventDefault()
									if (event.currentTarget instanceof HTMLFormElement) {
										void saveConnector(event.currentTarget)
									}
								}),
								css(cardCss),
							]}
						>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<h2 mix={css(cardTitleCss)}>{selectedLabel}</h2>
								<p mix={css(descriptionCss)}>
									Connector names are explicit, user-chosen, and unique across
									your account. The shared secret is loaded into the password
									field for editing.
								</p>
							</div>

							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Connector name</span>
								<input
									name="instanceId"
									type="text"
									value={editorState.instanceId}
									placeholder="home"
									disabled={isMutating}
									required
									mix={[
										on('input', (event) => {
											editorState = {
												...editorState,
												instanceId: event.currentTarget.value,
											}
											handle.update()
										}),
										css(inputCss),
									]}
								/>
							</label>
							<div mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Connector URL</span>
								{connectorUrl ? (
									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											alignItems: 'stretch',
											flexWrap: 'wrap',
										})}
									>
										<code
											mix={css({
												flex: '1 1 22rem',
												minWidth: 0,
												padding: spacing.sm,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.background,
												color: colors.text,
												fontFamily: 'monospace',
												fontSize: typography.fontSize.sm,
												overflowWrap: 'anywhere',
											})}
										>
											{connectorUrl}
										</code>
										<CopyToClipboard key={connectorUrl} url={connectorUrl} />
									</div>
								) : (
									<p mix={css(descriptionCss)}>
										Enter a connector name to build the connector WebSocket URL.
									</p>
								)}
								<p mix={css(descriptionCss)}>
									Includes your username <code>{username}</code> so connector
									sessions stay isolated to your account.
								</p>
							</div>
							<div mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>
									Shared secret
									{editorState.hasSharedSecret ? ' (saved)' : ''}
								</span>
								<div
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										alignItems: 'center',
										flexWrap: 'wrap',
									})}
								>
									<div
										mix={css({
											position: 'relative',
											flex: '1 1 18rem',
											minWidth: 0,
										})}
									>
										{showSharedSecret ? (
											<input
												name="sharedSecret"
												aria-label="Shared secret"
												type="text"
												value={editorState.sharedSecret}
												placeholder="Connector hello shared secret"
												autoComplete="off"
												disabled={isMutating}
												mix={[
													on('input', (event) => {
														setSharedSecret(event.currentTarget.value)
														handle.update()
													}),
													css({
														...inputCss,
														paddingRight: '3rem',
													}),
												]}
											/>
										) : (
											<input
												name="sharedSecret"
												aria-label="Shared secret"
												type="password"
												value={editorState.sharedSecret}
												placeholder="Connector hello shared secret"
												autoComplete="off"
												disabled={isMutating}
												mix={[
													on('input', (event) => {
														setSharedSecret(event.currentTarget.value)
														handle.update()
													}),
													css({
														...inputCss,
														paddingRight: '3rem',
													}),
												]}
											/>
										)}
										<button
											type="button"
											aria-label={
												showSharedSecret
													? 'Hide shared secret'
													: 'Show shared secret'
											}
											title={
												showSharedSecret
													? 'Hide shared secret'
													: 'Show shared secret'
											}
											disabled={isMutating || !editorState.sharedSecret}
											mix={[
												on('click', () => {
													showSharedSecret = !showSharedSecret
													handle.update()
												}),
												css(iconButtonCss),
											]}
										>
											{EyeIcon({ showSecret: showSharedSecret })}
										</button>
									</div>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', generateConnectorSecret),
											css(secondaryButtonCss),
										]}
									>
										Generate
									</button>
								</div>
							</div>
							<label
								mix={css({
									display: 'flex',
									alignItems: 'flex-start',
									gap: spacing.sm,
									color: colors.text,
								})}
							>
								<input
									name="enabled"
									type="checkbox"
									checked={editorState.enabled}
									disabled={isMutating}
									mix={[
										toggle(),
										on('change', (event) => {
											editorState = {
												...editorState,
												enabled: event.currentTarget.checked,
											}
											handle.update()
										}),
									]}
								/>
								<span>
									<strong>Enabled</strong>
									<br />
									<span mix={css({ color: colors.textMuted })}>
										Allow this connector secret to authenticate websocket hello
										messages.
									</span>
								</span>
							</label>
							<label
								mix={css({
									display: 'flex',
									alignItems: 'flex-start',
									gap: spacing.sm,
									color: colors.text,
								})}
							>
								<input
									name="attached"
									type="checkbox"
									checked={editorState.attached}
									disabled={isMutating || !editorState.enabled}
									mix={[
										toggle(),
										on('change', (event) => {
											if (!editorState.enabled) {
												event.currentTarget.checked = editorState.attached
												return
											}
											editorState = {
												...editorState,
												attached: event.currentTarget.checked,
											}
											handle.update()
										}),
									]}
								/>
								<span>
									<strong>Attach to normal Kody context</strong>
									<br />
									<span mix={css({ color: colors.textMuted })}>
										Include this ref in regular MCP and chat sessions for
										capability search, execution, and status checks.
									</span>
								</span>
							</label>

							{isEditing ? (
								<div
									mix={css({
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									})}
								>
									Last updated{' '}
									{formatTimestamp(
										connectors.find((item) => item.id === editorState.id)
											?.updatedAt ?? '',
									)}
								</div>
							) : null}

							<div
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									flexWrap: 'wrap',
								})}
							>
								<button
									type="submit"
									disabled={isMutating}
									mix={css(primaryButtonCss)}
								>
									{saveState === 'saving' ? 'Saving...' : 'Save connector'}
								</button>
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', startNewConnector),
										css(secondaryButtonCss),
									]}
								>
									Reset form
								</button>
								{isEditing ? (
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => {
												if (!deleteConfirm) {
													deleteConfirm = true
													handle.update()
													return
												}
												void deleteConnector()
											}),
											css(dangerButtonCss),
										]}
									>
										{saveState === 'deleting'
											? 'Deleting...'
											: deleteConfirm
												? 'Confirm delete'
												: 'Delete'}
									</button>
								) : null}
							</div>
						</form>
					</AccountManagementLayout>
				) : null}
			</AccountManagementShell>
		)
	}
}
