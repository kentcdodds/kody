import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import {
	addAccountAnchorId,
	nextSuggestedConnectionName,
	resolveAddAccountConnectionName,
} from '#client/routes/integration-provider-catalog.ts'
import { buildConnectOauthHref } from '#universal/oauth-connect.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	type IntegrationUsageDraft,
	accountIntegrationsApiPath,
	dangerButtonCss,
	integrationListId,
} from '#client/routes/account-integrations-shared.ts'

const addAccountLinkCss = {
	...primaryLinkCss,
	justifySelf: 'start',
	width: 'fit-content',
}

export function AddAccountForm(
	handle: Handle<{
		slug: string
		platform: boolean
		existingNames: ReadonlyArray<string>
		open: boolean
		openHref: string
	}>,
) {
	let nameError: string | null = null
	let editedName: string | null = null
	let boundSlug = handle.props.slug

	function connectHref(connectionName: string) {
		return buildConnectOauthHref({
			name: connectionName,
			platform: handle.props.platform,
			appSlug: handle.props.slug,
		})
	}

	return () => {
		if (handle.props.slug !== boundSlug) {
			boundSlug = handle.props.slug
			editedName = null
			nameError = null
		}
		const suggested = nextSuggestedConnectionName(
			handle.props.slug,
			handle.props.existingNames,
		)
		const name = editedName ?? suggested
		if (!handle.props.open) {
			return (
				<a
					href={handle.props.openHref}
					data-testid="add-account-open"
					data-prevent-scroll-reset
					mix={css(addAccountLinkCss)}
				>
					Add another account
				</a>
			)
		}
		return (
			<form
				id={addAccountAnchorId}
				data-testid="add-account-form"
				mix={[
					on('submit', (event) => {
						event.preventDefault()
						const resolved = resolveAddAccountConnectionName({
							name,
							suggested,
							existingNames: handle.props.existingNames,
						})
						if (!resolved.ok) {
							nameError = resolved.error
							handle.update()
							return
						}
						nameError = null
						window.location.assign(connectHref(resolved.name))
					}),
					css({
						display: 'grid',
						gap: spacing.sm,
						justifyItems: 'start',
						scrollMarginTop: '5.5rem',
					}),
				]}
			>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Connection name</span>
					<input
						type="text"
						name="connectionName"
						data-field-ring
						required
						value={name}
						aria-invalid={nameError ? 'true' : undefined}
						aria-describedby={nameError ? 'add-account-name-error' : undefined}
						{...passwordManagerIgnoreProps}
						mix={[
							on('input', (event) => {
								editedName = event.currentTarget.value
								nameError = null
								handle.update()
							}),
							css(accountInputCss),
						]}
					/>
					{nameError ? (
						<p
							id="add-account-name-error"
							role="alert"
							data-testid="add-account-name-error"
							mix={css({
								...descriptionCss,
								color: colors.error,
							})}
						>
							{nameError}
						</p>
					) : null}
				</label>
				<button
					type="submit"
					mix={css({
						...getPillButtonCss({ size: 'sm' }),
						display: 'inline-flex',
					})}
				>
					Connect
				</button>
			</form>
		)
	}
}

export function ConnectionUsageForm(
	handle: Handle<{
		connection: AccountIntegrationListItem
		savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
		draft: IntegrationUsageDraft
		saving: boolean
		onDraftChange: (draft: IntegrationUsageDraft) => void
		onSave: () => void
	}>,
) {
	return () => {
		const { connection, savedPackages, draft, saving, onDraftChange, onSave } =
			handle.props
		return (
			<section
				data-testid="integration-usage"
				mix={css({ display: 'grid', gap: spacing.xs })}
			>
				<p
					mix={css({
						...fieldLabelCss,
						margin: 0,
					})}
				>
					Usage
				</p>
				<label
					mix={css({
						display: 'flex',
						gap: spacing.xs,
						alignItems: 'flex-start',
						color: colors.text,
						fontSize: typography.fontSize.sm,
					})}
				>
					<input
						type="radio"
						name={`usage-mode-${connection.name}`}
						checked={draft.usageMode === 'any'}
						disabled={saving}
						mix={[
							on('change', () =>
								onDraftChange({
									usageMode: 'any',
									allowedPackageIds: [],
								}),
							),
						]}
					/>
					<span>Any context (execute and every package)</span>
				</label>
				<label
					mix={css({
						display: 'flex',
						gap: spacing.xs,
						alignItems: 'flex-start',
						color: colors.text,
						fontSize: typography.fontSize.sm,
					})}
				>
					<input
						type="radio"
						name={`usage-mode-${connection.name}`}
						checked={draft.usageMode === 'packages'}
						disabled={saving}
						mix={[
							on('change', () =>
								onDraftChange({
									usageMode: 'packages',
									allowedPackageIds: draft.allowedPackageIds,
								}),
							),
						]}
					/>
					<span>Specific packages only</span>
				</label>
				{draft.usageMode === 'packages' ? (
					savedPackages.length === 0 ? (
						<p mix={css({ ...descriptionCss, margin: 0 })}>
							Save a package first, then approve it here. Execute cannot use
							this connection while it is limited to specific packages.
						</p>
					) : (
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							{savedPackages.map((savedPackage) => {
								const checked = draft.allowedPackageIds.includes(
									savedPackage.id,
								)
								return (
									<label
										key={savedPackage.id}
										mix={css({
											display: 'flex',
											gap: spacing.xs,
											alignItems: 'center',
											fontSize: typography.fontSize.sm,
										})}
									>
										<input
											type="checkbox"
											checked={checked}
											disabled={saving}
											mix={[
												on('change', () =>
													onDraftChange({
														usageMode: 'packages',
														allowedPackageIds: checked
															? draft.allowedPackageIds.filter(
																	(id) => id !== savedPackage.id,
																)
															: [...draft.allowedPackageIds, savedPackage.id],
													}),
												),
											]}
										/>
										<span>{savedPackage.kodyId}</span>
									</label>
								)
							})}
						</div>
					)
				) : null}
				<button
					type="button"
					data-testid="save-integration-usage"
					disabled={saving}
					mix={[css(getPillButtonCss({ size: 'sm' })), on('click', onSave)]}
				>
					{saving ? 'Saving…' : 'Save usage'}
				</button>
			</section>
		)
	}
}

export function RotateCredentialsForm(
	handle: Handle<{
		app: AccountOauthAppListItem
		onRotated: (app: AccountOauthAppListItem) => void
	}>,
) {
	let clientId = handle.props.app.clientId
	let clientSecret = ''
	let confirmed = false
	let status: 'idle' | 'saving' = 'idle'
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let boundAppId = integrationListId(handle.props.app)

	function reset(app: AccountOauthAppListItem) {
		clientId = app.clientId
		clientSecret = ''
		confirmed = false
		status = 'idle'
		message = null
		messageTone = 'info'
		boundAppId = integrationListId(app)
	}

	async function submit(app: AccountOauthAppListItem) {
		if (status === 'saving') return
		const nextClientId = clientId.trim()
		const nextClientSecret = clientSecret.trim()
		if (!confirmed) {
			message =
				'Confirm that every connection on this app should use the new credentials.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (!nextClientId && !nextClientSecret) {
			message = 'Provide a new client id and/or client secret.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (nextClientId === app.clientId && !nextClientSecret) {
			message = 'Enter a new client id or client secret to rotate.'
			messageTone = 'error'
			handle.update()
			return
		}
		status = 'saving'
		message = null
		handle.update()
		try {
			const response = await fetch(accountIntegrationsApiPath, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'rotate_oauth_app_credentials',
					appSlug: app.slug,
					...(nextClientId ? { clientId: nextClientId } : {}),
					...(nextClientSecret ? { clientSecret: nextClientSecret } : {}),
					confirm: true,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok: boolean
				error?: string
				app?: AccountOauthAppListItem
			}>(response)
			if (!response.ok || !payload?.ok || !payload.app) {
				throw new Error(payload?.error || 'Unable to rotate credentials.')
			}
			const rotatedApp = payload.app
			reset(rotatedApp)
			message = 'Rotated shared credentials for this integration.'
			messageTone = 'info'
			handle.props.onRotated(rotatedApp)
			handle.update()
		} catch (error) {
			status = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to rotate credentials.'
			messageTone = 'error'
			handle.update()
		}
	}

	return () => {
		if (integrationListId(handle.props.app) !== boundAppId) {
			reset(handle.props.app)
		}
		const app = handle.props.app
		return (
			<>
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<form
					mix={[
						on('submit', (event) => {
							event.preventDefault()
							void submit(app)
						}),
						css({
							display: 'grid',
							gap: spacing.md,
							marginTop: spacing.sm,
						}),
					]}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>
							Client ID (optional to keep current)
						</span>
						<input
							type="text"
							data-field-ring
							name="oauthAppClientId"
							value={clientId}
							{...passwordManagerIgnoreProps}
							mix={[
								on('input', (event) => {
									clientId = event.currentTarget.value
									handle.update()
								}),
								css(accountInputCss),
							]}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>New client secret</span>
						<input
							type="password"
							data-field-ring
							name="oauthAppClientSecret"
							value={clientSecret}
							{...passwordManagerIgnoreProps}
							mix={[
								on('input', (event) => {
									clientSecret = event.currentTarget.value
									handle.update()
								}),
								css(accountInputCss),
							]}
						/>
					</label>
					<label
						mix={css({
							display: 'flex',
							alignItems: 'flex-start',
							gap: spacing.sm,
							color: colors.text,
							fontSize: typography.fontSize.sm,
						})}
					>
						<input
							type="checkbox"
							checked={confirmed}
							mix={on('change', (event) => {
								confirmed = event.currentTarget.checked
								handle.update()
							})}
						/>
						<span>
							I understand this updates credentials for
							{app.connections.length === 0
								? ' this integration'
								: app.connections.length === 1
									? ' 1 connection on this integration'
									: ` all ${app.connections.length} connections on this integration`}
							.
						</span>
					</label>
					<div>
						<button
							type="submit"
							disabled={status === 'saving' || !confirmed}
							mix={css(dangerButtonCss)}
						>
							{status === 'saving' ? 'Rotating...' : 'Rotate credentials'}
						</button>
					</div>
				</form>
			</>
		)
	}
}
