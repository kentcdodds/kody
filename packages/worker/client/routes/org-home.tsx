import { type RemixNode, css } from 'remix/component'
import { type IconName, renderIcon } from '#universal/icon.tsx'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { orgBillingPath, orgRoleManagesBilling } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * Main column of a non-personal organization's home. Its resources still live
 * in each member's personal account until storage follows `request.org.id`
 * (#3073), so this says where the organization's work happens today.
 * Grant-only collaborators see what was shared with them instead of member
 * management.
 */
export function renderOrgHomeMain(input: {
	slug: string
	handle: string
	role: OrgRole | null
}) {
	const collaborator = input.role === null
	return (
		<div mix={css(mainCss)} data-testid="org-home">
			<h2 mix={css(headingCss)}>Get started</h2>
			<ul mix={css(stepListCss)}>
				{renderStep({
					icon: collaborator ? 'key' : 'users',
					title: collaborator
						? 'Use what was shared with you'
						: 'Invite members and share access',
					body: collaborator
						? `${input.handle} shared specific resources with you. To use them, connect an agent and choose ${input.handle} on the approval screen.`
						: `Members, teams, and access grants are managed by an agent connected to ${input.handle}. When you connect one, choose ${input.handle} on the approval screen.`,
					action: (
						<a
							href={routes.accountConnections.href()}
							mix={css(getGhostButtonCss({ size: 'sm' }))}
						>
							Connect an agent
						</a>
					),
				})}
				{orgRoleManagesBilling(input.role)
					? renderStep({
							icon: 'wallet',
							title: 'Billing and seats',
							body: `Subscribe ${input.handle} to Kody Pro, billed per seat: every owner and member is one. Invoices and the payment method live there too.`,
							action: (
								<a
									href={orgBillingPath(input.slug)}
									data-testid="org-home-billing"
									mix={css(getGhostButtonCss({ size: 'sm' }))}
								>
									Open billing
								</a>
							),
						})
					: null}
				{renderStep({
					icon: 'box',
					title: 'Repositories, secrets, and jobs',
					body: `${input.handle}'s packages, secrets, and jobs will show up here. Until then, they stay in your personal account.`,
					action: null,
				})}
			</ul>
		</div>
	)
}

function renderStep(input: {
	icon: IconName
	title: string
	body: string
	action: RemixNode | null
}) {
	return (
		<li mix={css(stepCss)}>
			<span aria-hidden="true" mix={css(stepIconCss)}>
				{renderIcon(input.icon, { size: '1.25rem' })}
			</span>
			<div mix={css(stepCopyCss)}>
				<h3 mix={css(stepTitleCss)}>{input.title}</h3>
				<p mix={css(stepBodyCss)}>{input.body}</p>
				{input.action ? <div>{input.action}</div> : null}
			</div>
		</li>
	)
}

const mainCss = {
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}

const headingCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: 'clamp(1.35rem, 2.4vw, 1.7rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	color: colors.text,
}

const stepListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.md,
}

const stepCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	padding: spacing.lg,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const stepIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '2.5rem',
	height: '2.5rem',
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
}

const stepCopyCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}

const stepTitleCss = {
	margin: 0,
	fontSize: '1.05rem',
	fontWeight: 650,
	color: colors.text,
}

const stepBodyCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '60ch',
}
