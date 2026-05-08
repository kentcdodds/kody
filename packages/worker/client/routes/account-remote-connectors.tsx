import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
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

type RemoteConnectorListItem = {
	id: string
	kind: string
	instanceId: string
	enabled: boolean
	attached: boolean
	hasSharedSecret: boolean
	createdAt: string
	updatedAt: string
}

type AccountRemoteConnectorsPayload = {
	ok: true
	email: string
	connectors: Array<RemoteConnectorListItem>
	selectedConnectorId?: string
}

type EditorState = {
	id: string | null
	kind: string
	instanceId: string
	enabled: boolean
	attached: boolean
	sharedSecret: string
	hasSharedSecret: boolean
}

const accountRemoteConnectorsApiPath = '/account/remote-connectors.json'

function createEmptyEditorState(): EditorState {
	return {
		id: null,
		kind: '',
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
		kind: connector.kind,
		instanceId: connector.instanceId,
		enabled: connector.enabled,
		attached: connector.attached,
		sharedSecret: '',
		hasSharedSecret: connector.hasSharedSecret,
	}
}

function formatTimestamp(value: string) {
	return new Date(value).toLocaleString()
}

function connectorLabel(
	connector: Pick<RemoteConnectorListItem, 'kind' | 'instanceId'>,
) {
	return `${connector.kind}:${connector.instanceId}`
}

export function AccountRemoteConnectorsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveState: 'idle' | 'saving' | 'deleting' = 'idle'
	let email = ''
	let connectors: Array<RemoteConnectorListItem> = []
	let editorState = createEmptyEditorState()
	let message: string | null = null
	let lastLoadedHref = ''
	let deleteConfirm = false

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	async function loadRemoteConnectors(signal: AbortSignal) {
		try {
			const href =
				typeof window === 'undefined'
					? '/account/remote-connectors'
					: window.location.href
			lastLoadedHref = href
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
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load remote connector settings.'
			handle.update()
		}
	}

	function applyPayload(payload: AccountRemoteConnectorsPayload) {
		email = payload.email
		connectors = payload.connectors
		if (payload.selectedConnectorId) {
			const selected = connectors.find(
				(connector) => connector.id === payload.selectedConnectorId,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
			return
		}
		if (editorState.id) {
			const selected = connectors.find(
				(connector) => connector.id === editorState.id,
			)
			editorState = selected
				? createEditorStateFromConnector(selected)
				: createEmptyEditorState()
		}
	}

	async function saveConnector() {
		if (saveState !== 'idle') return
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
					id: editorState.id,
					kind: editorState.kind,
					instanceId: editorState.instanceId,
					enabled: editorState.enabled,
					attached: editorState.attached,
					sharedSecret: editorState.sharedSecret,
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
		editorState = createEditorStateFromConnector(connector)
		deleteConfirm = false
		message = null
		handle.update()
	}

	function startNewConnector() {
		editorState = createEmptyEditorState()
		deleteConfirm = false
		message = null
		handle.update()
	}

	return () => {
		const currentHref =
			typeof window === 'undefined'
				? '/account/remote-connectors'
				: window.location.href
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (status === 'loading' || isRefreshingForLocationChange) {
			handle.queueTask(loadRemoteConnectors)
		}
		const isMutating = saveState !== 'idle'
		const isEditing = Boolean(editorState.id)
		const selectedLabel =
			editorState.kind && editorState.instanceId
				? `${editorState.kind}:${editorState.instanceId}`
				: 'New remote connector'

		return (
			<section
				mix={css({
					maxWidth: '76rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.xl,
				})}
			>
				<header
					mix={css({
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'flex-start',
						gap: spacing.md,
						flexWrap: 'wrap',
					})}
				>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<h1
							mix={css({
								fontSize: typography.fontSize.xl,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
								margin: 0,
							})}
						>
							{email ? `${email} remote connectors` : 'Remote connectors'}
						</h1>
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							Attach connector refs to normal Kody sessions and manage the
							shared secrets used by connector hello authentication.
						</p>
					</div>
					<button
						type="button"
						disabled={isMutating}
						mix={[on('click', startNewConnector), css(primaryButtonCss)]}
					>
						New connector
					</button>
				</header>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading remote connectors...
					</p>
				) : null}
				{message ? (
					<p
						role="alert"
						mix={css({
							color: status === 'error' ? colors.error : colors.text,
							margin: 0,
						})}
					>
						{message}
					</p>
				) : null}

				{status === 'ready' ? (
					<section
						mix={css({
							display: 'grid',
							gridTemplateColumns: 'minmax(18rem, 24rem) minmax(0, 1fr)',
							gap: spacing.lg,
							alignItems: 'start',
							[mq.mobile]: {
								gridTemplateColumns: '1fr',
							},
						})}
					>
						<aside mix={css(cardCss)}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<h2 mix={css(cardTitleCss)}>Configured connectors</h2>
								<p mix={css(descriptionCss)}>
									Enabled and attached entries are included in your standard MCP
									and chat caller context.
								</p>
							</div>
							{connectors.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No remote connectors yet. Create one to get started.
								</p>
							) : (
								<ul
									mix={css({
										listStyle: 'none',
										padding: 0,
										margin: 0,
										display: 'grid',
										gap: spacing.sm,
									})}
								>
									{connectors.map((connector) => {
										const isSelected = editorState.id === connector.id
										return (
											<li key={connector.id}>
												<button
													type="button"
													mix={[
														on('click', () => selectConnector(connector)),
														css({
															width: '100%',
															display: 'grid',
															gap: spacing.xs,
															textAlign: 'left',
															padding: spacing.md,
															borderRadius: radius.md,
															border: `1px solid ${
																isSelected ? colors.primary : colors.border
															}`,
															backgroundColor: isSelected
																? colors.primarySoftest
																: colors.background,
															color: colors.text,
															cursor: 'pointer',
														}),
													]}
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
												</button>
											</li>
										)
									})}
								</ul>
							)}
						</aside>

						<form
							method="post"
							mix={[
								on('submit', (event) => {
									event.preventDefault()
									void saveConnector()
								}),
								css(cardCss),
							]}
						>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<h2 mix={css(cardTitleCss)}>{selectedLabel}</h2>
								<p mix={css(descriptionCss)}>
									Connector refs are generic kind and instance ID pairs. The
									shared secret is never returned by this page after saving.
								</p>
							</div>

							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Kind</span>
								<input
									type="text"
									value={editorState.kind}
									placeholder="lights"
									disabled={isMutating}
									required
									mix={[
										on('input', (event) => {
											editorState = {
												...editorState,
												kind: event.currentTarget.value,
											}
											handle.update()
										}),
										css(inputCss),
									]}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Instance ID</span>
								<input
									type="text"
									value={editorState.instanceId}
									placeholder="living-room"
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
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>
									Shared secret
									{editorState.hasSharedSecret ? ' (saved)' : ''}
								</span>
								<input
									type="password"
									value={editorState.sharedSecret}
									placeholder={
										editorState.hasSharedSecret
											? 'Leave blank to keep the saved secret'
											: 'Connector hello shared secret'
									}
									autoComplete="new-password"
									disabled={isMutating}
									required={!editorState.hasSharedSecret}
									mix={[
										on('input', (event) => {
											editorState = {
												...editorState,
												sharedSecret: event.currentTarget.value,
											}
											handle.update()
										}),
										css(inputCss),
									]}
								/>
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
									type="checkbox"
									checked={editorState.enabled}
									disabled={isMutating}
									mix={on('change', (event) => {
										editorState = {
											...editorState,
											enabled: event.currentTarget.checked,
										}
										handle.update()
									})}
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
									type="checkbox"
									checked={editorState.attached}
									disabled={isMutating || !editorState.enabled}
									mix={on('change', (event) => {
										editorState = {
											...editorState,
											attached: event.currentTarget.checked,
										}
										handle.update()
									})}
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
					</section>
				) : null}
			</section>
		)
	}
}
