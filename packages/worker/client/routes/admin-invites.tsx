import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
	noticeCardCss,
} from './account-management-components.tsx'
import {
	type AdminCreatedUserSetup,
	type AdminInvitesLoaderData,
	type AdminPlanName,
} from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type AdminInviteListItem = AdminInvitesLoaderData['invites'][number]
type PageStatus = 'loading' | 'ready' | 'error'

const adminInvitesApiPath = '/admin/invites.json'

function isAdminInvitesPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/invites'
}
function getInviteStatus(invite: AdminInviteListItem) {
	if (invite.revokedAt) return 'Revoked'
	if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
		return 'Expired'
	}
	if (invite.useCount >= invite.maxUses) return 'Exhausted'
	return 'Active'
}

export async function adminInvitesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminInvitesApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view invites.')
	}
	const payload = await readJson<AdminInvitesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load invites.')
	}
	return { adminInvites: payload }
}

export function AdminInvitesRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let invites: Array<AdminInviteListItem> = []
	let availablePlans: Array<AdminPlanName> = []
	let createdUser: AdminCreatedUserSetup | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let actionState: 'idle' | 'creating' | 'creatingUser' | 'revoking' = 'idle'
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null
	let loadRequestId = 0

	function applyData(payload: AdminInvitesLoaderData) {
		invites = payload.invites
		availablePlans = payload.availablePlans
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	async function loadInvites() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		// A slow response that resolves after a newer load started must not
		// clobber the newer load's state (matches the other admin loaders).
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminInvitesApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view invites.'
				messageTone = 'error'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminInvitesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load invites.')
			}
			applyData(payload)
			lastLoadedHref = href
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load invites.'
			messageTone = 'error'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	async function submitAdminAction(body: Record<string, unknown>) {
		actionState =
			body.action === 'create_invite'
				? 'creating'
				: body.action === 'create_user'
					? 'creatingUser'
					: 'revoking'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(adminInvitesApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(body),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminInvitesLoaderData & {
					ok?: boolean
					error?: string
					createdUser?: AdminCreatedUserSetup
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to update invites.')
			}
			applyData(payload)
			createdUser = payload.createdUser ?? createdUser
			message =
				body.action === 'create_invite'
					? 'Invite created.'
					: body.action === 'create_user'
						? 'User created. Copy the setup link below.'
						: 'Invite revoked.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to update invites.'
			messageTone = 'error'
		} finally {
			actionState = 'idle'
			handle.update()
		}
	}

	function handleCreateSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		void submitAdminAction({
			action: 'create_invite',
			code: String(formData.get('code') ?? '').trim(),
			note: String(formData.get('note') ?? '').trim(),
			maxUses: String(formData.get('maxUses') ?? '1').trim(),
			expiresAt: String(formData.get('expiresAt') ?? '').trim(),
			plan: String(formData.get('plan') ?? '').trim(),
		})
		event.currentTarget.reset()
	}

	function handleCreateUserSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget
		const formData = new FormData(form)
		createdUser = null
		void submitAdminAction({
			action: 'create_user',
			email: String(formData.get('email') ?? '').trim(),
			username: String(formData.get('username') ?? '').trim(),
		}).then(() => {
			if (createdUser) form.reset()
		})
	}

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const routeData = isAdminInvitesPath(currentHref)
			? tryConsumeRouteLoaderData(handle, 'adminInvites', currentHref)
			: undefined
		if (routeData) {
			applyData(routeData)
			lastLoadedHref = currentHref
			lastFailedHref = null
		}
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !routeData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!routeData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadInvites)
		}
		const isMutating = actionState !== 'idle'

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin invites"
					description="Create and revoke launch-cohort invite codes for production signup."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading invites…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<AccountManagementPanel
					title="Create user"
					description="Create a verified account with no usable password, then copy the setup link into a manual email."
					asForm
					onSubmit={handleCreateUserSubmit}
				>
					<div
						mix={css({
							display: 'grid',
							gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
							gap: spacing.md,
							alignItems: 'end',
							[mq.mobile]: {
								gridTemplateColumns: 'minmax(0, 1fr)',
								alignItems: 'stretch',
							},
						})}
					>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>User email</span>
							<input
								name="email"
								type="email"
								required
								placeholder="person@example.com"
								disabled={isMutating}
								mix={css(inputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Username (optional)</span>
							<input
								name="username"
								type="text"
								placeholder="Auto-generated from email"
								disabled={isMutating}
								mix={css(inputCss)}
							/>
						</label>
						<button
							type="submit"
							disabled={isMutating}
							mix={css(primaryButtonCss)}
						>
							{actionState === 'creatingUser' ? 'Creating…' : 'Create user'}
						</button>
					</div>
					{createdUser ? (
						<div mix={css(noticeCardCss)}>
							<p mix={css({ margin: 0 })}>
								Setup link for <strong>{createdUser.email}</strong>:
							</p>
							<input
								readOnly
								aria-label="Password setup link"
								value={createdUser.setupLink}
								mix={css(inputCss)}
							/>
							<a
								href={createdUser.setupLink}
								mix={css({ color: colors.primary })}
							>
								Open setup link
							</a>
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								Expires{' '}
								{formatNullableTimestamp(
									new Date(createdUser.setupTokenExpiresAt).toISOString(),
								)}
								.
							</p>
						</div>
					) : null}
				</AccountManagementPanel>
				<AccountManagementPanel
					title="Create invite"
					description="Leave the code blank to generate one automatically."
					asForm
					onSubmit={handleCreateSubmit}
				>
					<div
						mix={css({
							display: 'grid',
							gridTemplateColumns: 'repeat(5, minmax(0, 1fr)) auto',
							gap: spacing.md,
							alignItems: 'end',
							[mq.tablet]: {
								gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
							},
							[mq.mobile]: {
								gridTemplateColumns: 'minmax(0, 1fr)',
								alignItems: 'stretch',
							},
						})}
					>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Code</span>
							<input
								name="code"
								type="text"
								placeholder="Optional"
								disabled={isMutating}
								mix={css(inputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Note</span>
							<input
								name="note"
								type="text"
								placeholder="Cohort or recipient"
								disabled={isMutating}
								mix={css(inputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Max uses</span>
							<input
								name="maxUses"
								type="number"
								min="1"
								defaultValue="1"
								disabled={isMutating}
								mix={css(inputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Plan</span>
							<select name="plan" disabled={isMutating} mix={css(inputCss)}>
								<option value="">Legacy / unlimited</option>
								{availablePlans.map((plan) => (
									<option key={plan} value={plan}>
										{plan}
									</option>
								))}
							</select>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Expires</span>
							<input
								name="expiresAt"
								type="datetime-local"
								disabled={isMutating}
								mix={css(inputCss)}
							/>
						</label>
						<button
							type="submit"
							disabled={isMutating}
							mix={css(primaryButtonCss)}
						>
							{actionState === 'creating' ? 'Creating…' : 'Create'}
						</button>
					</div>
				</AccountManagementPanel>
				<section mix={css(cardCss)}>
					<h2
						mix={css({
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							margin: 0,
						})}
					>
						Invites
					</h2>
					<p mix={css(descriptionCss)}>
						Invite codes are operator-controlled account-administration
						metadata.
					</p>
					{status === 'ready' && invites.length === 0 ? (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No invites yet.
						</p>
					) : null}
					<div mix={css({ display: 'grid', gap: spacing.md })}>
						{invites.map((invite) => (
							<article
								key={invite.code}
								mix={css({
									border: `1px solid ${colors.border}`,
									borderRadius: '0.75rem',
									padding: spacing.md,
									display: 'grid',
									gap: spacing.md,
								})}
							>
								<div
									mix={css({
										display: 'flex',
										justifyContent: 'space-between',
										gap: spacing.md,
										flexWrap: 'wrap',
									})}
								>
									<div>
										<h3 mix={css({ margin: 0 })}>{invite.code}</h3>
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											{invite.note || 'No note'}
										</p>
									</div>
									<button
										type="button"
										disabled={isMutating || Boolean(invite.revokedAt)}
										mix={[
											on(
												'click',
												() =>
													void submitAdminAction({
														action: 'revoke_invite',
														code: invite.code,
													}),
											),
											css(secondaryButtonCss),
										]}
									>
										{actionState === 'revoking' ? 'Revoking…' : 'Revoke'}
									</button>
								</div>
								<MetadataGrid
									columns={3}
									items={[
										{ label: 'Status', value: getInviteStatus(invite) },
										{
											label: 'Uses',
											value: `${invite.useCount} / ${invite.maxUses}`,
										},
										{
											label: 'Plan',
											value: invite.plan ?? 'Legacy / unlimited',
										},
										{
											label: 'Expires',
											value: formatNullableTimestamp(invite.expiresAt),
										},
										{
											label: 'Created',
											value: formatNullableTimestamp(invite.createdAt),
										},
										{
											label: 'Created by',
											value:
												invite.createdByEmail ??
												(invite.createdBy == null
													? 'Unknown'
													: String(invite.createdBy)),
										},
										{
											label: 'Revoked',
											value: formatNullableTimestamp(invite.revokedAt),
										},
									]}
								/>
							</article>
						))}
					</div>
				</section>
			</AccountManagementShell>
		)
	}
}
