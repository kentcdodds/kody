import { css, type Handle, type RemixNode } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { renderIcon } from '#universal/icon.tsx'
import {
	type OrgTeamView,
	type ScopedInviteLinkView,
} from '#universal/loader-data.ts'
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

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}

function creatorLabel(link: ScopedInviteLinkView) {
	if (link.createdByDisplayName?.trim()) return link.createdByDisplayName.trim()
	if (link.createdByUsername) return `@${link.createdByUsername}`
	return 'Someone'
}

/**
 * Per-team invite links on the Teams page. Accepting one adds the person to
 * the org as Member (when they are not one yet) and to the team.
 */
export function createOrgTeamInviteLinks(
	handle: Handle,
	options: {
		createLink: (teamId: string) => Promise<{ id: string; url: string } | null>
		revokeLink: (linkId: string) => Promise<void>
		onMessage: (message: string, tone: 'info' | 'error') => void
		/**
		 * Runs after this section's last render for an action. A route-data
		 * reload started earlier would be aborted by that render.
		 */
		onChanged: () => void
	},
) {
	let busy: string | null = null
	let created: { teamId: string; linkId: string; url: string } | null = null

	async function create(teamId: string) {
		if (busy) return
		busy = `create:${teamId}`
		handle.update()
		let changed = false
		try {
			const link = await options.createLink(teamId)
			if (link) {
				changed = true
				created = { teamId, linkId: link.id, url: link.url }
				const copied = await copyText(link.url)
				options.onMessage(
					copied
						? 'Team invite link copied to clipboard.'
						: 'Team invite link created. Copy it below; it is shown only once.',
					'info',
				)
			}
		} catch (error) {
			options.onMessage(
				error instanceof Error
					? error.message
					: 'Unable to create that invite link.',
				'error',
			)
		} finally {
			busy = null
			handle.update()
			if (changed) options.onChanged()
		}
	}

	async function revoke(linkId: string) {
		if (busy) return
		busy = `revoke:${linkId}`
		handle.update()
		let changed = false
		try {
			await options.revokeLink(linkId)
			changed = true
			if (created?.linkId === linkId) created = null
			options.onMessage('Team invite link revoked.', 'info')
		} catch (error) {
			options.onMessage(
				error instanceof Error
					? error.message
					: 'Unable to revoke that invite link.',
				'error',
			)
		} finally {
			busy = null
			handle.update()
			if (changed) options.onChanged()
		}
	}

	function render(
		team: OrgTeamView,
		links: ReadonlyArray<ScopedInviteLinkView>,
	): RemixNode {
		const teamLinks = links.filter((link) => link.teamId === team.id)
		const createdUrl = created?.teamId === team.id ? created.url : null
		return (
			<div mix={css(sectionCss)} data-testid="org-team-invite-links">
				<div mix={css(headerCss)}>
					<span mix={css(detailCss)}>
						Invite link: whoever accepts joins this team, and the organization
						as Member if they are not in it yet.
					</span>
					<button
						type="button"
						disabled={busy !== null}
						data-testid="org-team-invite-link-create"
						mix={[
							css(getPillButtonCss({ size: 'sm' })),
							on('click', () => void create(team.id)),
						]}
					>
						{renderIcon('link', { size: '1.05rem' })}
						{busy === `create:${team.id}` ? 'Creating…' : 'Copy invite link'}
					</button>
				</div>
				{createdUrl ? (
					<div mix={css(createdCss)} data-testid="org-team-invite-link-url">
						<code mix={css(codeCss)}>{createdUrl}</code>
					</div>
				) : null}
				{teamLinks.length > 0 ? (
					<ul mix={css(listCss)}>
						{teamLinks.map((link) => (
							<li
								key={link.id}
								mix={css(rowCss)}
								data-testid="org-team-invite-link"
							>
								<span mix={css(detailCss)}>
									{[
										`${link.useCount}${link.maxUses != null ? ` / ${link.maxUses}` : ''} uses`,
										`Expires ${formatTimestampDate(link.expiresAt)}`,
										`Created by ${creatorLabel(link)}`,
									].join(' · ')}
								</span>
								<button
									type="button"
									disabled={busy !== null}
									mix={[
										css(getDangerPillCss({ size: 'sm' })),
										on('click', () => void revoke(link.id)),
									]}
								>
									{busy === `revoke:${link.id}` ? 'Revoking…' : 'Revoke'}
								</button>
							</li>
						))}
					</ul>
				) : null}
			</div>
		)
	}

	return { render }
}

const sectionCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.sm,
	paddingTop: spacing.sm,
	borderTop: `1px solid ${colors.border}`,
}

const headerCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
}

const detailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
}

const createdCss = {
	padding: spacing.sm,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const codeCss = {
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
	color: colors.text,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

const rowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
}
