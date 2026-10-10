import { css, ref, type Handle } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { AccountAvatarEditor } from '#client/routes/account-avatar-editor.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgIdentity } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

type SettingsPayload = OrgSettingsLoaderData & {
	redirectTo?: string | null
	error?: string
}

async function fetchSettings(
	slug: string,
	signal: AbortSignal,
): Promise<SettingsPayload | 'unauthorized' | 'not-found'> {
	const response = await fetch(routes.orgSettingsApi.href({ orgSlug: slug }), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized'
	if (response.status === 404) return 'not-found'
	const payload = (await response
		.json()
		.catch(() => null)) as SettingsPayload | null
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to load settings.')
	}
	return payload
}

function slugFromHref(href: string) {
	const match = /^\/@([^/]+)\/-\/settings/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ?? ''
}

export async function orgSettingsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const slug = slugFromHref(url.pathname)
	const payload = await fetchSettings(slug, signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	if (payload === 'not-found') {
		return routeLoaderRedirect(routes.notFoundPage.href())
	}
	return { orgSettings: payload }
}

export function OrgSettingsRoute(handle: Handle) {
	const settingsData = createRouteData({
		key: 'orgSettings',
		async load(href, signal) {
			const payload = await fetchSettings(slugFromHref(href), signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			if (payload === 'not-found') throw new Error('Organization unavailable.')
			return payload
		},
	})

	let draftName = ''
	let draftSlug = ''
	let appliedKey = ''
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let saving = false
	let avatarStatus: 'idle' | 'editing' | 'uploading' | 'removing' = 'idle'
	let avatarFile: File | null = null
	let dialogOpen = false
	let confirmation = ''
	let deleting = false
	let dialogNode: HTMLDialogElement | null = null

	function applyPayload(payload: OrgSettingsLoaderData) {
		const key = `${payload.org.id}:${payload.org.slug}:${payload.org.displayName}`
		if (key === appliedKey) return
		appliedKey = key
		draftName = payload.org.displayName ?? ''
		draftSlug = payload.org.slug
	}

	function closeDialog() {
		dialogOpen = false
		confirmation = ''
		deleting = false
		dialogNode?.close()
		handle.update()
	}

	async function saveProfile(event: SubmitEvent) {
		event.preventDefault()
		const snapshot = settingsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok || !data.canManage) return
		saving = true
		message = null
		handle.update()
		try {
			const response = await fetch(
				routes.orgSettingsPost.href({ orgSlug: data.org.slug }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({
						displayName: draftName,
						slug: draftSlug,
					}),
				},
			)
			const payload = (await response
				.json()
				.catch(() => null)) as SettingsPayload | null
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save settings.')
			}
			if (payload.redirectTo) {
				window.location.assign(payload.redirectTo)
				return
			}
			appliedKey = ''
			settingsData.reload(handle, readCurrentRouterHref(handle))
			message = 'Settings saved.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to save settings.'
			messageTone = 'error'
		} finally {
			saving = false
			handle.update()
		}
	}

	async function uploadAvatar(prepared: File) {
		const snapshot = settingsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok) return
		avatarStatus = 'uploading'
		handle.update()
		try {
			const body = new FormData()
			body.set('avatar', prepared)
			const response = await fetch(
				routes.orgSettingsAvatarPost.href({ orgSlug: data.org.slug }),
				{
					method: 'POST',
					headers: { Accept: 'application/json' },
					credentials: 'include',
					body,
				},
			)
			const payload = (await response
				.json()
				.catch(() => null)) as SettingsPayload | null
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save avatar.')
			}
			appliedKey = ''
			settingsData.reload(handle, readCurrentRouterHref(handle))
			message = 'Avatar updated.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to save avatar.'
			messageTone = 'error'
		} finally {
			avatarStatus = 'idle'
			avatarFile = null
			handle.update()
		}
	}

	async function removeAvatar() {
		const snapshot = settingsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok) return
		avatarStatus = 'removing'
		handle.update()
		try {
			const response = await fetch(
				routes.orgSettingsAvatarPost.href({ orgSlug: data.org.slug }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ remove: true }),
				},
			)
			const payload = (await response
				.json()
				.catch(() => null)) as SettingsPayload | null
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to remove avatar.')
			}
			appliedKey = ''
			settingsData.reload(handle, readCurrentRouterHref(handle))
			message = 'Avatar removed.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to remove avatar.'
			messageTone = 'error'
		} finally {
			avatarStatus = 'idle'
			handle.update()
		}
	}

	async function deleteOrg(event: SubmitEvent) {
		event.preventDefault()
		const snapshot = settingsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok) return
		deleting = true
		handle.update()
		try {
			const response = await fetch(
				routes.orgSettingsDeletePost.href({ orgSlug: data.org.slug }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ confirmation }),
				},
			)
			const payload = (await response.json().catch(() => null)) as {
				ok?: boolean
				error?: string
				redirectTo?: string
			} | null
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete this organization.')
			}
			window.location.assign(
				payload.redirectTo ?? routes.accountOrganizations.href(),
			)
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to delete this organization.'
			messageTone = 'error'
			deleting = false
			handle.update()
		}
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		const consumed = tryConsumeRouteLoaderData(handle, 'orgSettings', href)
		if (consumed && 'ok' in consumed && consumed.ok) applyPayload(consumed)
		const snapshot = settingsData.read(handle, href)
		const data = snapshot.data
		if (data?.ok) applyPayload(data)
		const pending = snapshot.kind === 'pending'
		const identity = data
			? orgIdentity(data.org, { displayName: '', avatarUrl: null })
			: null
		const confirmationMatches =
			confirmation === data?.org.slug || confirmation === 'DELETE'

		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Settings"
					description="The organization's name, handle, and photo."
					currentHref={href}
				/>
				{snapshot.kind === 'error' ? (
					<AccountManagementMessage tone="error">
						{snapshot.error?.message ?? 'Unable to load settings.'}
					</AccountManagementMessage>
				) : null}
				{!data && snapshot.kind === 'pending' ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading settings…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{data?.ok && data.org.personal ? (
					<AccountManagementPanel title="Identity">
						<p mix={css(mutedCopyCss)}>
							This is your personal organization. Your name, photo, and handle
							come from your{' '}
							<a href={routes.account.href()} mix={css(inlineLinkCss)}>
								account profile
							</a>
							. To delete your account, use{' '}
							<a href={routes.accountData.href()} mix={css(inlineLinkCss)}>
								Account → Data & deletion
							</a>
							.
						</p>
					</AccountManagementPanel>
				) : null}
				{data?.ok && !data.org.personal && identity ? (
					<>
						<AccountManagementPanel title="Profile">
							<div
								mix={css(identityRowCss)}
								data-testid="org-settings-identity"
							>
								<UserAvatar
									displayName={identity.avatarName}
									avatarUrl={identity.avatarUrl}
									size={44}
									variant="well"
								/>
								<span mix={css(identityTextCss)}>
									<span mix={css(identityNameCss)}>{identity.name}</span>
									<span mix={css(identityDetailCss)}>{identity.handle}</span>
								</span>
							</div>
							{data.canManage ? (
								<div mix={css(avatarActionsCss)}>
									<label mix={css(getGhostButtonCss({ size: 'sm' }))}>
										{renderIcon('photo', { size: '1.05rem' })}
										{identity.avatarUrl ? 'Change photo' : 'Add photo'}
										<input
											type="file"
											accept="image/png,image/jpeg,image/webp"
											hidden
											mix={on('change', (event) => {
												const input = event.currentTarget as HTMLInputElement
												const file = input.files?.[0] ?? null
												input.value = ''
												if (!file) return
												avatarFile = file
												avatarStatus = 'editing'
												handle.update()
											})}
										/>
									</label>
									{identity.avatarUrl ? (
										<button
											type="button"
											mix={[
												css(getGhostButtonCss({ size: 'sm' })),
												on('click', () => void removeAvatar()),
											]}
											disabled={avatarStatus !== 'idle'}
										>
											Remove photo
										</button>
									) : null}
								</div>
							) : null}
							{avatarStatus === 'editing' ? (
								<AccountAvatarEditor
									file={avatarFile}
									onCancel={() => {
										avatarFile = null
										avatarStatus = 'idle'
										handle.update()
									}}
									onApply={(prepared) => void uploadAvatar(prepared)}
									onBusyChange={() => undefined}
								/>
							) : null}
							{data.canManage ? (
								<form
									mix={[
										css(formCss),
										on('submit', (event) => void saveProfile(event)),
									]}
								>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>Name</span>
										<input
											name="displayName"
											required
											maxLength={80}
											value={draftName}
											data-field-ring
											mix={[
												css(accountInputCss),
												on('input', (event) => {
													draftName = (event.currentTarget as HTMLInputElement)
														.value
													handle.update()
												}),
											]}
										/>
									</label>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>Handle</span>
										<span mix={css(slugFieldCss)}>
											<span aria-hidden="true" mix={css(slugPrefixCss)}>
												kody.codes/@
											</span>
											<input
												name="slug"
												required
												minLength={3}
												maxLength={32}
												pattern="[a-z0-9][a-z0-9\-]{1,30}[a-z0-9]"
												autoCapitalize="none"
												autoComplete="off"
												spellCheck={false}
												value={draftSlug}
												data-field-ring
												mix={[
													css(slugInputCss),
													on('input', (event) => {
														draftSlug = (
															event.currentTarget as HTMLInputElement
														).value.toLowerCase()
														handle.update()
													}),
												]}
											/>
										</span>
										<p mix={css(accountFieldNoteCss)}>
											3 to 32 letters, numbers, and hyphens. Changing the handle
											changes the organization's address.
										</p>
									</label>
									<div mix={css(accountActionsCss)}>
										<button
											type="submit"
											disabled={saving}
											mix={css(getPillButtonCss({ size: 'sm' }))}
										>
											{saving ? 'Saving…' : 'Save changes'}
										</button>
									</div>
								</form>
							) : (
								<p mix={css(mutedCopyCss)}>
									Only an owner can change this organization's profile.
								</p>
							)}
						</AccountManagementPanel>
						{data.canDelete ? (
							<AccountManagementPanel title="Delete organization">
								<p mix={css(accountFieldNoteCss)}>
									This soft-deletes the organization. Members lose access
									immediately. Restoration is possible for 30 days.
								</p>
								<div mix={css(accountActionsCss)}>
									<button
										type="button"
										data-testid="delete-org"
										mix={[
											css(getDangerPillCss({ size: 'sm' })),
											on('click', () => {
												dialogOpen = true
												confirmation = ''
												handle.update()
												dialogNode?.showModal()
											}),
										]}
									>
										{renderIcon('warning-triangle', { size: '1.05rem' })}
										Delete organization
									</button>
								</div>
								<dialog
									aria-labelledby="delete-org-title"
									data-testid="delete-org-dialog"
									mix={[
										css(deleteDialogCss),
										ref((node, signal) => {
											if (!(node instanceof HTMLDialogElement)) return
											dialogNode = node
											if (dialogOpen && !node.open) node.showModal()
											signal.addEventListener('abort', () => {
												dialogNode = null
											})
										}),
										on('cancel', (event) => {
											event.preventDefault()
											closeDialog()
										}),
										on('click', (event) => {
											if (event.target === event.currentTarget) closeDialog()
										}),
									]}
								>
									<form
										method="dialog"
										mix={[css(deleteDialogFormCss), on('submit', deleteOrg)]}
									>
										<h3 id="delete-org-title" mix={css(deleteDialogTitleCss)}>
											Delete @{data.org.slug}?
										</h3>
										<p mix={css(accountFieldNoteCss)}>
											Type <strong>{data.org.slug}</strong> or{' '}
											<strong>DELETE</strong> to confirm.
										</p>
										<label mix={css(accountFieldCss)}>
											<span mix={css(accountFieldLabelCss)}>Confirmation</span>
											<input
												value={confirmation}
												data-field-ring
												autoComplete="off"
												mix={[
													css(accountInputCss),
													on('input', (event) => {
														confirmation = (
															event.currentTarget as HTMLInputElement
														).value
														handle.update()
													}),
												]}
											/>
										</label>
										<div mix={css(accountActionsCss)}>
											<button
												type="submit"
												disabled={!confirmationMatches || deleting}
												mix={css(getDangerPillCss({ size: 'sm' }))}
											>
												{deleting ? 'Deleting…' : 'Delete organization'}
											</button>
											<button
												type="button"
												mix={[
													css(getGhostButtonCss({ size: 'sm' })),
													on('click', closeDialog),
												]}
											>
												Cancel
											</button>
										</div>
									</form>
								</dialog>
							</AccountManagementPanel>
						) : null}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
}

const inlineLinkCss = {
	color: colors.primaryText,
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
	marginTop: spacing.md,
}

const identityRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const identityTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
}

const identityNameCss = {
	fontWeight: 650,
}

const identityDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const avatarActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	marginTop: spacing.md,
}

const slugFieldCss = {
	display: 'flex',
	alignItems: 'stretch',
	minWidth: 0,
}

const slugPrefixCss = {
	display: 'inline-flex',
	alignItems: 'center',
	paddingInline: '0.85rem',
	borderRadius: '12px 0 0 12px',
	border: `1.5px solid ${colors.fieldBorder}`,
	borderRight: 'none',
	backgroundColor: colors.background,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}

const slugInputCss = {
	...accountInputCss,
	flex: '1 1 auto',
	minWidth: 0,
	borderTopLeftRadius: 0,
	borderBottomLeftRadius: 0,
}

const deleteDialogCss = {
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: spacing.lg,
	maxWidth: '28rem',
	width: 'calc(100% - 2rem)',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'rgba(15, 18, 16, 0.45)',
	},
}

const deleteDialogFormCss = {
	display: 'grid',
	gap: spacing.md,
}

const deleteDialogTitleCss = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 700,
}
