import { type Handle, css } from 'remix/component'
import { readAppSession } from '#client/app-session-context.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import {
	workspaceRailGroups,
	type AccountRailItem,
} from '#client/routes/account-rail.ts'
import { renderIcon } from '#universal/icon.tsx'
import { parseOrgOverviewPath } from '#universal/org-pages.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'

export async function orgOverviewRouteLoader(): Promise<RouteLoaderResult> {
	return {}
}

/**
 * Workspace overview for the signup organization: every section it owns, one
 * click away. The server redirects a team org's overview to its home; this
 * client fallback covers an in-app navigation that skips the server.
 */
export function OrgOverviewRoute(handle: Handle) {
	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = new URL(currentHref, 'http://localhost').pathname
		const slug = parseOrgOverviewPath(pathname)?.slug ?? null
		const session = readAppSession(handle)?.session ?? null
		const org = session?.organizations?.find((entry) => entry.slug === slug)
		// Same stale-list fallback as pageRail: an unknown slug that is not the
		// signup username is treated as a team member, not a personal owner.
		const personal =
			org?.personal ?? (slug !== null && slug === (session?.username ?? null))
		const role =
			org !== undefined
				? org.role
				: personal
					? ('owner' as const)
					: slug
						? ('member' as const)
						: null
		// Same section cards for personal and team. The server still redirects a
		// team overview URL to `/@slug`; this client path covers in-app hops.
		const groups = workspaceRailGroups({
			orgSlug: slug,
			personal,
			role,
		}).flatMap((group) =>
			group.label === null
				? []
				: [{ label: group.label, items: group.items, note: group.note }],
		)

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Overview"
					description={
						slug
							? `Everything @${slug} holds: repositories, agents, MCP servers, secrets, jobs, memories, and the rest.`
							: 'Everything your workspace holds.'
					}
					currentHref={currentHref}
				/>
				{groups.map((group) => (
					<AccountManagementPanel key={group.label} title={group.label}>
						{group.note ? (
							<p mix={css(groupNoteCss)} data-testid="org-overview-group-note">
								{group.note}
							</p>
						) : null}
						<ul
							aria-label={group.label}
							data-testid={`org-overview-${group.label
								.toLowerCase()
								.replace(/[^a-z0-9]+/g, '-')}`}
							mix={css(cardGridCss)}
						>
							{group.items.map(renderCard)}
						</ul>
					</AccountManagementPanel>
				))}
			</AccountManagementShell>
		)
	}
}

function renderCard(item: AccountRailItem) {
	return (
		<li key={item.href}>
			<a href={item.href} mix={css(cardCss)}>
				<span aria-hidden="true" mix={css(cardIconCss)}>
					{renderIcon(item.icon, { size: '1.15rem' })}
				</span>
				<span mix={css(cardCopyCss)}>
					<span mix={css(cardTitleCss)}>{item.label}</span>
					{item.description ? (
						<span mix={css(cardBodyCss)}>{item.description}</span>
					) : null}
				</span>
			</a>
		</li>
	)
}

const groupNoteCss = {
	margin: `0 0 ${spacing.sm}`,
	fontSize: '0.9rem',
	lineHeight: 1.45,
	color: colors.textMuted,
}

const cardGridCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
	gap: spacing.sm,
}

const cardCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	height: '100%',
	boxSizing: 'border-box' as const,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
	'&:hover': {
		borderColor: colors.primary,
	},
}

const cardIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '2.25rem',
	height: '2.25rem',
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
}

const cardCopyCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const cardTitleCss = {
	fontSize: '1rem',
	fontWeight: 650,
}

const cardBodyCss = {
	fontSize: '0.9rem',
	color: colors.textMuted,
	lineHeight: 1.45,
}
