import { type RemixNode, css } from 'remix/component'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { teamOrgManagementItems } from '#client/routes/account-rail.ts'
import { type IconName, renderIcon } from '#universal/icon.tsx'
import {
	orgBillingPath,
	orgMembersPath,
	orgResourcePath,
	orgRoleManagesBilling,
	orgSettingsPath,
} from '#universal/org-pages.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * Main column of a non-personal organization's home. Secrets, jobs, and the
 * other org sections read that org. Repositories and connected agents still
 * read the signed-in person. Grant-only collaborators see what was shared
 * with them instead of member management.
 */
export function renderOrgHomeMain(input: {
	slug: string
	handle: string
	role: OrgRole | null
}) {
	const collaborator = input.role === null
	const manageItems = teamOrgManagementItems({
		orgSlug: input.slug,
		role: input.role,
	})
	return (
		<div mix={css(mainCss)} data-testid="org-home">
			{manageItems.length > 0 ? (
				<nav
					aria-label={`${input.handle} sections`}
					data-testid="org-home-nav"
					mix={css(navCss)}
				>
					<p mix={css(navEyebrowCss)}>Organization</p>
					<ul mix={css(navListCss)}>
						{manageItems.map((item) => (
							<li key={item.href}>
								<a
									href={item.href}
									data-testid={`org-home-nav-${item.label.toLowerCase()}`}
									mix={css(navLinkCss)}
								>
									<span aria-hidden="true" mix={css(navIconCss)}>
										{renderIcon(item.icon, { size: '1.1rem' })}
									</span>
									{item.label}
								</a>
							</li>
						))}
					</ul>
				</nav>
			) : null}
			<h2 mix={css(headingCss)}>Get started</h2>
			<ul mix={css(stepListCss)}>
				{collaborator
					? renderStep({
							icon: 'key',
							title: 'Use what was shared with you',
							body: `${input.handle} shared specific resources with you. To use them, connect an agent and choose ${input.handle} on the approval screen.`,
							action: (
								<a
									href={orgResourcePath(input.slug, 'connections')}
									mix={css(getGhostButtonCss({ size: 'sm' }))}
								>
									Connect an agent
								</a>
							),
						})
					: input.role === 'owner'
						? renderStep({
								icon: 'users',
								title: 'Invite members and share access',
								body: `Add people to ${input.handle} and choose their role. You can also update the organization's profile.`,
								action: (
									<div mix={css(stepActionsCss)}>
										<a
											href={orgMembersPath(input.slug)}
											mix={css(getGhostButtonCss({ size: 'sm' }))}
										>
											Members
										</a>
										<a
											href={orgSettingsPath(input.slug)}
											mix={css(getGhostButtonCss({ size: 'sm' }))}
										>
											Settings
										</a>
									</div>
								),
							})
						: renderStep({
								icon: 'users',
								title: 'View members and the organization profile',
								body: `See who is in ${input.handle} and open the organization's profile. Only an Owner can invite people or edit settings.`,
								action: (
									<div mix={css(stepActionsCss)}>
										<a
											href={orgMembersPath(input.slug)}
											mix={css(getGhostButtonCss({ size: 'sm' }))}
										>
											Members
										</a>
										<a
											href={orgSettingsPath(input.slug)}
											mix={css(getGhostButtonCss({ size: 'sm' }))}
										>
											Settings
										</a>
									</div>
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
					title: 'Secrets and jobs',
					body: `Secrets, jobs, and the rest of ${input.handle}'s workspace are on this organization. Repositories and connected agents still live in your personal account.`,
					action: (
						<div mix={css(stepActionsCss)}>
							<a
								href={orgResourcePath(input.slug, 'secrets')}
								mix={css(getGhostButtonCss({ size: 'sm' }))}
							>
								Secrets
							</a>
							<a
								href={orgResourcePath(input.slug, 'jobs')}
								mix={css(getGhostButtonCss({ size: 'sm' }))}
							>
								Jobs
							</a>
						</div>
					),
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

const navCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.lg,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const navEyebrowCss = {
	margin: 0,
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const navListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}

const navLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	color: colors.text,
	textDecoration: 'none',
	fontSize: '0.95rem',
	fontWeight: 600,
	'&:hover': {
		borderColor: colors.primary,
		color: colors.primaryText,
	},
}

const navIconCss = {
	display: 'inline-flex',
	color: colors.primaryText,
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

const stepActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
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
