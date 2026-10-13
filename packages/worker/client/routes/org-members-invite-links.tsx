import { css, type Handle, type RemixNode } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import { type OrgInviteLinkView } from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

const inviteLinkRoles = ['member', 'billing'] as const

function creatorLabel(link: OrgInviteLinkView) {
	if (link.createdByDisplayName?.trim()) return link.createdByDisplayName.trim()
	if (link.createdByUsername) return `@${link.createdByUsername}`
	return 'Someone'
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}

export function createOrgMembersInviteLinks(
	handle: Handle,
	options: {
		createLink: (body: Record<string, unknown>) => Promise<{
			inviteLink?: { url: string }
		} | null>
		revokeLink: (linkId: string) => Promise<void>
		onMessage: (message: string, tone: 'info' | 'error') => void
		onBeforeMutate?: () => void
	},
) {
	let inviteLinkRole: (typeof inviteLinkRoles)[number] = 'member'
	let inviteLinkDomains = ''
	let inviteLinkMaxUses = ''
	let inviteLinkExpiresDays = '7'
	let creatingLink = false
	let copiedLinkUrl: string | null = null
	let revokingLinkId: string | null = null

	async function createInviteLink(event: SubmitEvent) {
		event.preventDefault()
		creatingLink = true
		copiedLinkUrl = null
		options.onBeforeMutate?.()
		handle.update()
		try {
			const maxUsesRaw = inviteLinkMaxUses.trim()
			const expiresRaw = inviteLinkExpiresDays.trim()
			const payload = await options.createLink({
				role: inviteLinkRole,
				allowedEmailDomains: inviteLinkDomains,
				maxUses: maxUsesRaw.length > 0 ? maxUsesRaw : null,
				expiresInDays: expiresRaw.length > 0 ? expiresRaw : '7',
			})
			const url = payload?.inviteLink?.url ?? null
			if (url) {
				const copied = await copyText(url)
				copiedLinkUrl = url
				options.onMessage(
					copied
						? 'Invite link copied to clipboard.'
						: 'Invite link created. Copy it below.',
					'info',
				)
			} else {
				options.onMessage('Invite link created.', 'info')
			}
		} catch (error) {
			options.onMessage(
				error instanceof Error
					? error.message
					: 'Unable to create that invite link.',
				'error',
			)
		} finally {
			creatingLink = false
			handle.update()
		}
	}

	async function revokeInviteLink(linkId: string) {
		revokingLinkId = linkId
		copiedLinkUrl = null
		handle.update()
		try {
			await options.revokeLink(linkId)
			options.onMessage('Invite link revoked.', 'info')
		} catch (error) {
			options.onMessage(
				error instanceof Error
					? error.message
					: 'Unable to revoke that invite link.',
				'error',
			)
		} finally {
			revokingLinkId = null
			handle.update()
		}
	}

	function clearCopiedLink() {
		copiedLinkUrl = null
	}

	function render(inviteLinks: ReadonlyArray<OrgInviteLinkView>): RemixNode {
		return (
			<>
				<AccountManagementPanel title="Invite link">
					<form
						data-testid="org-invite-link-form"
						mix={[
							css(formCss),
							on('submit', (event) => void createInviteLink(event)),
						]}
					>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Role</span>
							<select
								value={inviteLinkRole}
								aria-label="Invite link role"
								mix={[
									css(selectCss),
									on('change', (event) => {
										const next = (event.currentTarget as HTMLSelectElement)
											.value
										if (next === 'member' || next === 'billing') {
											inviteLinkRole = next
											handle.update()
										}
									}),
								]}
							>
								{inviteLinkRoles.map((role) => (
									<option key={role} value={role}>
										{orgRoleLabel(role)}
									</option>
								))}
							</select>
							<p mix={css(accountFieldNoteCss)}>
								Anyone with the link joins as this role. Owner cannot be granted
								through a link.
							</p>
						</label>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>
								Allowed email domains (optional)
							</span>
							<input
								value={inviteLinkDomains}
								data-field-ring
								autoComplete="off"
								placeholder="example.com, partner.org"
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										inviteLinkDomains = (
											event.currentTarget as HTMLInputElement
										).value
										handle.update()
									}),
								]}
							/>
							<p mix={css(accountFieldNoteCss)}>
								Leave blank to allow any verified email. Domains check the
								account’s verified email.
							</p>
						</label>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Max uses (optional)</span>
							<input
								value={inviteLinkMaxUses}
								data-field-ring
								inputMode="numeric"
								autoComplete="off"
								placeholder="Unlimited"
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										inviteLinkMaxUses = (
											event.currentTarget as HTMLInputElement
										).value
										handle.update()
									}),
								]}
							/>
						</label>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Expires in days</span>
							<input
								value={inviteLinkExpiresDays}
								data-field-ring
								inputMode="numeric"
								autoComplete="off"
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										inviteLinkExpiresDays = (
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
								disabled={creatingLink}
								mix={css(getPillButtonCss({ size: 'sm' }))}
								data-testid="org-invite-link-copy"
							>
								{renderIcon('link', { size: '1.05rem' })}
								{creatingLink ? 'Creating…' : 'Copy invite link'}
							</button>
						</div>
					</form>
					{copiedLinkUrl ? (
						<div mix={css(copiedLinkCss)} data-testid="invite-link-url">
							<code mix={css(copiedLinkCodeCss)}>{copiedLinkUrl}</code>
							<button
								type="button"
								mix={[
									css(getPillButtonCss({ size: 'sm' })),
									on('click', () => {
										void copyText(copiedLinkUrl!).then((copied) => {
											options.onMessage(
												copied
													? 'Invite link copied to clipboard.'
													: 'Could not copy the link. Select it manually.',
												copied ? 'info' : 'error',
											)
											handle.update()
										})
									}),
								]}
							>
								{renderIcon('copy', { size: '1.05rem' })}
								Copy again
							</button>
						</div>
					) : null}
				</AccountManagementPanel>
				{inviteLinks.length > 0 ? (
					<AccountManagementPanel title="Active invite links">
						<ul mix={css(listCss)} data-testid="org-invite-links">
							{inviteLinks.map((link) => (
								<li key={link.id} mix={css(rowItemCss)}>
									<div mix={css(rowCss)}>
										<span aria-hidden="true" mix={css(inviteIconCss)}>
											{renderIcon('link', { size: '1.25rem' })}
										</span>
										<span mix={css(rowTextCss)}>
											<span mix={css(rowNameCss)}>{link.roleLabel} link</span>
											<span mix={css(rowDetailCss)}>
												{[
													`${link.useCount}${
														link.maxUses != null ? ` / ${link.maxUses}` : ''
													} uses`,
													`Expires ${formatTimestampDate(link.expiresAt)}`,
													`Created by ${creatorLabel(link)}`,
													link.allowedEmailDomains.length > 0
														? `Domains ${link.allowedEmailDomains.join(', ')}`
														: null,
												]
													.filter(Boolean)
													.join(' · ')}
											</span>
										</span>
										<span mix={css(rowActionsCss)}>
											<button
												type="button"
												disabled={revokingLinkId === link.id}
												mix={[
													css(getDangerPillCss({ size: 'sm' })),
													on('click', () => void revokeInviteLink(link.id)),
												]}
											>
												{revokingLinkId === link.id ? 'Revoking…' : 'Revoke'}
											</button>
										</span>
									</div>
								</li>
							))}
						</ul>
					</AccountManagementPanel>
				) : null}
			</>
		)
	}

	return { render, clearCopiedLink }
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

const selectCss = {
	...accountInputCss,
	width: 'auto',
	minWidth: '8rem',
	padding: '0.45rem 0.7rem',
	[mq.mobile]: {
		minWidth: 'min(100%, 8rem)',
		maxWidth: '100%',
	},
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
	[mq.mobile]: {
		flexWrap: 'wrap',
		alignItems: 'flex-start',
	},
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
	// Zero basis keeps a long detail beside the icon on a phone row.
	[mq.mobile]: {
		flex: '1 1 0%',
		maxWidth: '100%',
	},
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[mq.mobile]: {
		whiteSpace: 'normal',
		overflowWrap: 'anywhere',
	},
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
	[mq.mobile]: {
		overflowWrap: 'anywhere',
	},
}

const rowActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	flexShrink: 0,
	[mq.mobile]: {
		flex: '1 0 100%',
		maxWidth: '100%',
		minWidth: 0,
	},
}

const inviteIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	flexShrink: 0,
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
}

const copiedLinkCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.lg,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const copiedLinkCodeCss = {
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
	color: colors.text,
}
