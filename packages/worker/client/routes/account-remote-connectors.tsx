import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import {
	RecordDot,
	RecordTable,
	RecordTableSearch,
	recordBodyCss,
	recordCellClamp,
} from '#client/routes/record-table.tsx'
import {
	colors,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	focusRingCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(26))
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
const remoteConnectorsRoute = createListDetailRoute(accountRemoteConnectorsPath)

/**
 * List/detail/new and `q` filter variants share one connectors payload.
 * Key the load latch on the base path so selection and search do not refetch.
 */
function getDataRefreshKey(_href: string) {
	return accountRemoteConnectorsPath
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

function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

function selectionSyncKey(selection: {
	selectedId: string | null
	isCreating: boolean
}) {
	if (selection.isCreating) return 'new'
	if (selection.selectedId) return `id:${selection.selectedId}`
	return 'none'
}

function connectorMatchesSearch(
	connector: RemoteConnectorListItem,
	search: string,
) {
	return matchesSearchQuery(search, [
		connector.instanceId,
		connector.enabled ? 'enabled' : 'disabled',
		connector.attached ? 'attached' : 'not attached',
	])
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
						...getGhostButtonCss({ size: 'sm' }),
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

/**
 * Theme-aware switch styling for the enabled/attached checkboxes. The
 * `remix/ui/toggle` mixin ships hardcoded light-mode colors that clash with
 * the app theme (especially in dark mode), so the track and thumb are built
 * from the shared design tokens instead.
 */
const switchCss = {
	appearance: 'none' as const,
	WebkitAppearance: 'none' as const,
	position: 'relative' as const,
	flex: 'none',
	width: '2.75rem',
	height: '1.5rem',
	margin: 0,
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.full,
	backgroundColor: colors.background,
	cursor: 'pointer',
	transition: `background-color ${transitions.normal}, border-color ${transitions.normal}`,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		top: '50%',
		left: '0.125rem',
		width: '1.125rem',
		height: '1.125rem',
		borderRadius: radius.full,
		backgroundColor: colors.textMuted,
		boxShadow: shadows.sm,
		transform: 'translateY(-50%)',
		transition: `transform ${transitions.normal}, background-color ${transitions.normal}`,
	},
	'&:not(:disabled):hover': {
		borderColor: colors.primary,
	},
	'&:checked': {
		backgroundColor: colors.primary,
		borderColor: colors.primary,
	},
	'&:checked::before': {
		backgroundColor: colors.onPrimary,
		transform: 'translateY(-50%) translateX(1.25rem)',
	},
	'&:focus-visible': {
		...focusRingCss,
	},
	'&:disabled': {
		cursor: 'not-allowed',
		opacity: 0.55,
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&::before': {
			transition: 'none',
		},
	},
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
	const deleteConnectorCheck = createDoubleCheck(handle)
	let showSharedSecret = false
	let syncedSelectionKey: string | null = null

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function syncRouterLocation(nextPath: string) {
		// Do not pre-mark the destination as loaded: `navigate` is async
		// (preload-then-commit), so until it commits the current href is
		// unchanged and a pre-set would make interim renders look like a
		// location change and fire a spurious fallback fetch for the old URL.
		// The commit render consumes the navigation's preloaded data (or the
		// stale marker) and marks the latch itself.
		navigate(nextPath)
	}

	function buildHrefWithUpdatedSearch(search: string) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function syncEditorToSelection(selection: {
		selectedId: string | null
		isCreating: boolean
	}) {
		const nextKey = selectionSyncKey(selection)
		if (nextKey === syncedSelectionKey) return
		syncedSelectionKey = nextKey
		deleteConnectorCheck.reset()
		showSharedSecret = false
		if (selection.isCreating) {
			editorState = createEmptyEditorState()
			return
		}
		if (selection.selectedId) {
			const selected = connectors.find(
				(connector) => connector.id === selection.selectedId,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
			return
		}
		editorState = createEmptyEditorState()
	}

	async function loadRemoteConnectors(signal: AbortSignal) {
		const href = getCurrentHref()
		const dataKey = getDataRefreshKey(href)
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
			loadLatch.markLoaded(dataKey)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load remote connector settings.'
			loadLatch.markFailed(dataKey)
			handle.update()
		}
	}

	function applyPayload(payload: AccountRemoteConnectorsPayload) {
		username = payload.username
		connectorUrlOrigin = payload.connectorUrlOrigin
		connectors = payload.connectors
		deleteConnectorCheck.reset()
		if (payload.selectedConnectorId) {
			const selected = connectors.find(
				(connector) => connector.id === payload.selectedConnectorId,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
			showSharedSecret = false
			// Align with the current URL, not the post-create detail target.
			// `navigate` is async; an interim `/new` render must not see an
			// id-keyed sync marker and wipe the freshly seeded editor.
			syncedSelectionKey = selectionSyncKey(
				remoteConnectorsRoute.getSelection(getCurrentHref()),
			)
			return
		}
		syncedSelectionKey = null
		syncEditorToSelection(remoteConnectorsRoute.getSelection(getCurrentHref()))
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
			if (!wasEditing && payload.selectedConnectorId) {
				syncRouterLocation(
					remoteConnectorsRoute.buildDetailHref(
						payload.selectedConnectorId,
						getCurrentSearch(),
					),
				)
			}
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
			syncedSelectionKey = 'none'
			deleteConnectorCheck.reset()
			saveState = 'idle'
			message = 'Deleted remote connector.'
			syncRouterLocation(
				remoteConnectorsRoute.buildListHref(getCurrentSearch()),
			)
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
		editorState = createEditorStateFromConnector(connector)
		syncedSelectionKey = `id:${connector.id}`
		deleteConnectorCheck.reset()
		showSharedSecret = false
		message = null
		handle.update()
	}

	function startNewConnector() {
		editorState = createEmptyEditorState()
		syncedSelectionKey = 'new'
		deleteConnectorCheck.reset()
		showSharedSecret = false
		message = null
		syncRouterLocation(remoteConnectorsRoute.buildNewHref(getCurrentSearch()))
		handle.update()
	}

	function resetEditor() {
		const selection = remoteConnectorsRoute.getSelection(getCurrentHref())
		if (selection.isCreating) {
			editorState = createEmptyEditorState()
		} else if (selection.selectedId) {
			const selected = connectors.find(
				(connector) => connector.id === selection.selectedId,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
		} else {
			editorState = createEmptyEditorState()
		}
		deleteConnectorCheck.reset()
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
		if (!remoteConnectorsRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountRemoteConnectors',
			href,
		)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		// Keep mutation feedback across list/detail/new navigations; explicit
		// refetch via loadRemoteConnectors still clears message.
		loadLatch.markLoaded(getDataRefreshKey(href))
		return true
	}

	return () => {
		const currentHref = getCurrentHref()
		const dataKey = getDataRefreshKey(currentHref)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref: dataKey,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadRemoteConnectors)
		}

		const selection = remoteConnectorsRoute.getSelection(currentHref)
		syncEditorToSelection(selection)
		const search = readSearchFilter(currentHref)
		const filteredConnectors = connectors.filter((connector) =>
			connectorMatchesSearch(connector, search),
		)
		const selectedConnector =
			selection.selectedId == null
				? null
				: (connectors.find(
						(connector) => connector.id === selection.selectedId,
					) ?? null)
		const isMutating = saveState !== 'idle'
		const isEditing = selectedConnector != null
		const showEditor = selection.isCreating || selectedConnector != null
		const selectedLabel = selection.isCreating
			? 'New remote connector'
			: (selectedConnector?.instanceId ?? editorState.instanceId)
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
					<RecordTable
						mode="pane"
						ariaLabel="Configured remote connectors"
						selectedId={selection.selectedId}
						countLabel={`${filteredConnectors.length} of ${connectors.length} shown`}
						emptyLabel={
							connectors.length === 0
								? 'No remote connectors yet. Create one to get started.'
								: 'No connectors match the current filters.'
						}
						toolbar={
							<RecordTableSearch
								label="Search connectors"
								placeholder="Search connectors"
								value={search}
								onInput={(value) => {
									replaceLocation(buildHrefWithUpdatedSearch(value))
								}}
							/>
						}
						columns={[
							{ key: 'name', label: 'Connector', primary: true },
							{ key: 'enabled', label: 'Enabled' },
							{ key: 'attached', label: 'Attached' },
							{ key: 'secret', label: 'Secret' },
							{ key: 'url', label: 'URL', drop: 1 },
						]}
						rows={filteredConnectors.map((connector) => ({
							id: connector.id,
							// A save or delete is in flight; the editor below owns the
							// selection until it settles.
							href: isMutating
								? undefined
								: remoteConnectorsRoute.buildDetailHref(
										connector.id,
										getCurrentSearch(),
									),
							cells: {
								name: connectorLabel(connector),
								enabled: (
									<RecordDot
										active={connector.enabled}
										title={connector.enabled ? 'Enabled' : 'Disabled'}
									/>
								),
								attached: (
									<RecordDot
										active={connector.attached}
										title={connector.attached ? 'Attached' : 'Not attached'}
									/>
								),
								secret: (
									<RecordDot
										active={connector.hasSharedSecret}
										title={
											connector.hasSharedSecret
												? 'Secret saved'
												: 'Missing secret'
										}
									/>
								),
								url: <span mix={clampedCellCss}>{connector.connectorUrl}</span>,
							},
						}))}
						onNavigate={(connectorId) => {
							const connector = filteredConnectors.find(
								(entry) => entry.id === connectorId,
							)
							if (connector) selectConnector(connector)
						}}
						record={
							showEditor ? (
								<form
									method="post"
									noValidate
									{...passwordManagerIgnoreProps}
									mix={[
										on('submit', (event) => {
											event.preventDefault()
											if (event.currentTarget instanceof HTMLFormElement) {
												void saveConnector(event.currentTarget)
											}
										}),
										css(recordBodyCss),
									]}
								>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>{selectedLabel}</h2>
										<p mix={css(descriptionCss)}>
											Connector names are explicit, user-chosen, and unique
											across your account. The shared secret is loaded into the
											password field for editing.
										</p>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Connector name</span>
										<input
											data-field-ring
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
												css(accountInputCss),
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
												<CopyToClipboard
													key={connectorUrl}
													url={connectorUrl}
												/>
											</div>
										) : (
											<p mix={css(descriptionCss)}>
												Enter a connector name to build the connector WebSocket
												URL.
											</p>
										)}
										<p mix={css(descriptionCss)}>
											Includes your username <code>{username}</code> so
											connector sessions stay isolated to your account.
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
														data-field-ring
														name="sharedSecret"
														aria-label="Shared secret"
														type="text"
														value={editorState.sharedSecret}
														placeholder="Connector hello shared secret"
														{...passwordManagerIgnoreProps}
														disabled={isMutating}
														mix={[
															on('input', (event) => {
																setSharedSecret(event.currentTarget.value)
																handle.update()
															}),
															css({
																...accountInputCss,
																paddingRight: '3rem',
															}),
														]}
													/>
												) : (
													<input
														data-field-ring
														name="sharedSecret"
														aria-label="Shared secret"
														type="password"
														value={editorState.sharedSecret}
														placeholder="Connector hello shared secret"
														{...passwordManagerIgnoreProps}
														disabled={isMutating}
														mix={[
															on('input', (event) => {
																setSharedSecret(event.currentTarget.value)
																handle.update()
															}),
															css({
																...accountInputCss,
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
											role="switch"
											checked={editorState.enabled}
											aria-checked={editorState.enabled}
											disabled={isMutating}
											mix={[
												css(switchCss),
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
												Allow this connector secret to authenticate websocket
												hello messages.
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
											role="switch"
											checked={editorState.attached}
											aria-checked={editorState.attached}
											disabled={isMutating || !editorState.enabled}
											mix={[
												css(switchCss),
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
											{formatTimestamp(selectedConnector?.updatedAt ?? '')}
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
											mix={[on('click', resetEditor), css(secondaryButtonCss)]}
										>
											Reset form
										</button>
										{isEditing ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													...deleteConnectorCheck.getButtonMix({
														on: {
															click: () => void deleteConnector(),
														},
													}),
													css(dangerButtonCss),
												]}
											>
												{saveState === 'deleting'
													? 'Deleting...'
													: deleteConnectorCheck.doubleCheck
														? 'Confirm delete'
														: 'Delete'}
											</button>
										) : null}
									</div>
								</form>
							) : null
						}
					/>
				) : null}
			</AccountManagementShell>
		)
	}
}
