import { css, type Handle } from 'remix/component'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
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
import {
	type OrgMembersLoaderData,
	type OrgMemberView,
} from '#universal/loader-data.ts'
import { orgIdentity, orgRoleLabel } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

type MembersPayload = OrgMembersLoaderData & {
	error?: string
	invite?: { prompt: string }
}

const memberRoles = ['owner', 'member', 'billing'] as const

async function fetchMembers(
	slug: string,
	signal: AbortSignal,
): Promise<MembersPayload | 'unauthorized' | 'not-found'> {
	const response = await fetch(routes.orgMembersApi.href({ orgSlug: slug }), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized'
	if (response.status === 404) return 'not-found'
	const payload = (await response
		.json()
		.catch(() => null)) as MembersPayload | null
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to load members.')
	}
	return payload
}

function slugFromHref(href: string) {
	const match = /^\/@([^/]+)\/-\/members/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ?? ''
}

function memberName(member: OrgMemberView) {
	return (
		member.displayName?.trim() ||
		(member.username ? `@${member.username}` : member.userId)
	)
}

export async function orgMembersRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchMembers(slugFromHref(url.pathname), signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	if (payload === 'not-found') {
		return routeLoaderRedirect(routes.notFoundPage.href())
	}
	return { orgMembers: payload }
}

export function OrgMembersRoute(handle: Handle) {
	const membersData = createRouteData({
		key: 'orgMembers',
		async load(href, signal) {
			const payload = await fetchMembers(slugFromHref(href), signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			if (payload === 'not-found') throw new Error('Organization unavailable.')
			return payload
		},
	})

	const removeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	/** Latest role known saved for a member; survives until membersData reloads. */
	const confirmedRoles = new Map<string, string>()
	const roleChangeInFlight = new Set<string>()
	let invitee = ''
	let inviteRole: (typeof memberRoles)[number] = 'member'
	let inviting = false
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let invitePrompt: string | null = null

	function removeCheckFor(userId: string) {
		const existing = removeChecks.get(userId)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		removeChecks.set(userId, created)
		return created
	}

	function displayedRole(userId: string, fetchedRole: string) {
		return confirmedRoles.get(userId) ?? fetchedRole
	}

	async function postMember(
		path: 'role' | 'remove' | 'invite',
		body: Record<string, unknown>,
	) {
		const snapshot = membersData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok) return
		const href =
			path === 'role'
				? routes.orgMembersRolePost.href({ orgSlug: data.org.slug })
				: path === 'remove'
					? routes.orgMembersRemovePost.href({ orgSlug: data.org.slug })
					: routes.orgMembersInvitePost.href({ orgSlug: data.org.slug })
		const response = await fetch(href, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify(body),
		})
		const payload = (await response
			.json()
			.catch(() => null)) as MembersPayload | null
		if (response.status === 401) {
			window.location.assign('/login')
			return
		}
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error || 'Unable to update members.')
		}
		membersData.reload(handle, readCurrentRouterHref(handle))
		return payload
	}

	async function changeRole(
		userId: string,
		role: string,
		select: HTMLSelectElement,
		fetchedRole: string,
	) {
		if (roleChangeInFlight.has(userId)) {
			select.value = displayedRole(userId, fetchedRole)
			return
		}
		const previousRole = displayedRole(userId, fetchedRole)
		if (role === previousRole) return
		roleChangeInFlight.add(userId)
		message = null
		handle.update()
		try {
			await postMember('role', { userId, role })
			confirmedRoles.set(userId, role)
			message = 'Role updated.'
			messageTone = 'info'
		} catch (error) {
			select.value = previousRole
			message =
				error instanceof Error ? error.message : 'Unable to update role.'
			messageTone = 'error'
		} finally {
			roleChangeInFlight.delete(userId)
			handle.update()
		}
	}

	async function removeMember(userId: string) {
		message = null
		handle.update()
		try {
			await postMember('remove', { userId })
			message = 'Member removed.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to remove that member.'
			messageTone = 'error'
		}
		handle.update()
	}

	async function invite(event: SubmitEvent) {
		event.preventDefault()
		inviting = true
		message = null
		invitePrompt = null
		handle.update()
		try {
			const payload = await postMember('invite', {
				invitee,
				role: inviteRole,
			})
			invitee = ''
			invitePrompt = payload?.invite?.prompt ?? null
			message = invitePrompt
				? 'Invite created. Send this prompt to them.'
				: 'Invite created.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to send that invite.'
			messageTone = 'error'
		} finally {
			inviting = false
			handle.update()
		}
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		tryConsumeRouteLoaderData(handle, 'orgMembers', href)
		const snapshot = membersData.read(handle, href)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'
		const ownerCount =
			data?.members.filter((member) => member.role === 'owner').length ?? 0

		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Members"
					description="People who belong to this organization."
					currentHref={href}
				/>
				{snapshot.kind === 'error' ? (
					<AccountManagementMessage tone="error">
						{snapshot.error?.message ?? 'Unable to load members.'}
					</AccountManagementMessage>
				) : null}
				{!data && snapshot.kind === 'pending' ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading members…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{invitePrompt ? (
					<pre mix={css(promptCss)} data-testid="invite-prompt">
						{invitePrompt}
					</pre>
				) : null}
				{data?.ok ? (
					<>
						<AccountManagementPanel
							title="People"
							ariaLabel="Organization members"
						>
							<ul mix={css(listCss)} data-testid="org-members">
								{data.members.map((member) => {
									const check = removeCheckFor(member.userId)
									const lastOwner = member.role === 'owner' && ownerCount <= 1
									const identity = orgIdentity(
										{
											slug: member.username ?? member.userId,
											displayName: member.displayName,
											personal: false,
											avatarUrl: member.avatarUrl,
										},
										{ displayName: '', avatarUrl: null },
									)
									return (
										<li
											key={member.userId}
											data-testid="org-member"
											mix={css(rowItemCss)}
										>
											<div mix={css(rowCss)}>
												<UserAvatar
													displayName={identity.avatarName}
													avatarUrl={member.avatarUrl}
													size={44}
													variant="well"
												/>
												<span mix={css(rowTextCss)}>
													<span mix={css(rowNameCss)}>
														{memberName(member)}
													</span>
													<span mix={css(rowDetailCss)}>
														{member.username
															? `@${member.username} · ${member.roleLabel}`
															: member.roleLabel}
													</span>
												</span>
												{data.canManage ? (
													<span mix={css(rowActionsCss)}>
														<select
															aria-label={`Role for ${memberName(member)}`}
															value={displayedRole(member.userId, member.role)}
															disabled={
																lastOwner ||
																roleChangeInFlight.has(member.userId)
															}
															mix={[
																css(selectCss),
																on('change', (event) => {
																	const select =
																		event.currentTarget as HTMLSelectElement
																	void changeRole(
																		member.userId,
																		select.value,
																		select,
																		member.role,
																	)
																}),
															]}
														>
															{memberRoles.map((role) => (
																<option key={role} value={role}>
																	{orgRoleLabel(role)}
																</option>
															))}
														</select>
														<button
															type="button"
															disabled={lastOwner}
															mix={[
																css(getDangerPillCss({ size: 'sm' })),
																...check.getButtonMix({
																	on: {
																		click: () =>
																			void removeMember(member.userId),
																	},
																}),
															]}
														>
															{renderIcon('user-cross', { size: '1.05rem' })}
															{check.doubleCheck ? 'Confirm remove' : 'Remove'}
														</button>
													</span>
												) : (
													<span mix={css(quietPillCss)}>
														{member.roleLabel}
													</span>
												)}
											</div>
										</li>
									)
								})}
							</ul>
						</AccountManagementPanel>
						{data.canManage ? (
							<AccountManagementPanel title="Invite">
								<form
									data-testid="org-invite-form"
									mix={[
										css(formCss),
										on('submit', (event) => void invite(event)),
									]}
								>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>
											Email or username
										</span>
										<input
											value={invitee}
											required
											data-field-ring
											autoComplete="off"
											mix={[
												css(accountInputCss),
												on('input', (event) => {
													invitee = (event.currentTarget as HTMLInputElement)
														.value
													handle.update()
												}),
											]}
										/>
										<p mix={css(accountFieldNoteCss)}>
											They accept by pasting the invite prompt into their agent.
										</p>
									</label>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>Role</span>
										<select
											value={inviteRole}
											mix={[
												css(selectCss),
												on('change', (event) => {
													const next = (
														event.currentTarget as HTMLSelectElement
													).value
													if (
														next === 'owner' ||
														next === 'member' ||
														next === 'billing'
													) {
														inviteRole = next
														handle.update()
													}
												}),
											]}
										>
											{memberRoles.map((role) => (
												<option key={role} value={role}>
													{orgRoleLabel(role)}
												</option>
											))}
										</select>
									</label>
									<div mix={css(accountActionsCss)}>
										<button
											type="submit"
											disabled={inviting || invitee.trim().length === 0}
											mix={css(getPillButtonCss({ size: 'sm' }))}
										>
											{renderIcon('plus', { size: '1.05rem' })}
											{inviting ? 'Inviting…' : 'Send invite'}
										</button>
									</div>
								</form>
							</AccountManagementPanel>
						) : null}
						{data.canManage && data.invites.length > 0 ? (
							<AccountManagementPanel title="Pending invites">
								<ul mix={css(listCss)} data-testid="org-invites">
									{data.invites.map((invite) => (
										<li key={invite.id} mix={css(rowItemCss)}>
											<div mix={css(rowCss)}>
												<span aria-hidden="true" mix={css(inviteIconCss)}>
													{renderIcon('mail', { size: '1.25rem' })}
												</span>
												<span mix={css(rowTextCss)}>
													<span mix={css(rowNameCss)}>
														{invite.inviteeEmail ??
															(invite.inviteeUsername
																? `@${invite.inviteeUsername}`
																: 'Invite')}
													</span>
													<span mix={css(rowDetailCss)}>
														{[
															invite.roleLabel,
															`Expires ${formatTimestampDate(invite.expiresAt)}`,
														]
															.filter(Boolean)
															.join(' · ')}
													</span>
												</span>
											</div>
										</li>
									))}
								</ul>
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

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowItemCss = {
	minWidth: 0,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const rowActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	flexShrink: 0,
}

const selectCss = {
	...accountInputCss,
	width: 'auto',
	minWidth: '8rem',
	padding: '0.45rem 0.7rem',
}

const quietPillCss = {
	display: 'inline-flex',
	alignItems: 'center',
	fontSize: '0.8rem',
	fontWeight: 600,
	borderRadius: radius.full,
	padding: '0.1rem 0.6rem',
	color: colors.textMuted,
	boxShadow: `inset 0 0 0 1px ${colors.border}`,
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

const inviteIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
}

const promptCss = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.card,
	backgroundColor: colors.background,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}
