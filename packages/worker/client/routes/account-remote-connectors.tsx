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
const generatedSecretBytes = 32

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

function bytesToBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const value of bytes) {
		binary += String.fromCharCode(value)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

function generateSharedSecret() {
	const bytes = new Uint8Array(generatedSecretBytes)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
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
	let email = ''
	let connectors: Array<RemoteConnectorListItem> = []
	let editorState = createEmptyEditorState()
	let message: string | null = null
	let lastLoadedHref = ''
	let deleteConfirm = false
	let showSharedSecret = false

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
			kind: String(formData.get('kind') ?? '').trim(),
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
		if (!nextEditorState.kind.trim()) {
			message = 'Connector kind is required.'
			handle.update()
			return
		}
		if (!nextEditorState.instanceId.trim()) {
			message = 'Connector instance ID is required.'
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
					kind: nextEditorState.kind,
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

	async function copySharedSecret() {
		if (!editorState.sharedSecret) return
		try {
			await navigator.clipboard.writeText(editorState.sharedSecret)
			message = 'Copied shared secret.'
		} catch {
			message = 'Unable to copy shared secret.'
		}
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
									Connector refs are generic kind and instance ID pairs. The
									shared secret is never returned by this page after saving.
								</p>
							</div>

							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Kind</span>
								<input
									name="kind"
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
									name="instanceId"
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
												placeholder={
													editorState.hasSharedSecret
														? 'Leave blank to keep the saved secret'
														: 'Connector hello shared secret'
												}
												autoComplete="new-password"
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
												placeholder={
													editorState.hasSharedSecret
														? 'Leave blank to keep the saved secret'
														: 'Connector hello shared secret'
												}
												autoComplete="new-password"
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
									<button
										type="button"
										disabled={isMutating || !editorState.sharedSecret}
										mix={[
											on('click', () => void copySharedSecret()),
											css(secondaryButtonCss),
										]}
									>
										Copy
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
									name="attached"
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
