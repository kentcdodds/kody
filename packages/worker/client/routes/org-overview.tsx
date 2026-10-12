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
import { routes } from '#universal/routes.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

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
		const teamOrg = org !== undefined && !org.personal
		const groups = workspaceRailGroups({
			orgSlug: slug,
			personal: true,
			role: 'owner',
		}).flatMap((group) =>
			group.label === null ? [] : [{ label: group.label, items: group.items }],
		)

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Overview"
					description={
						slug
							? `Everything @${slug} holds: repositories, connections, MCP servers, secrets, jobs, memories, and the rest.`
							: 'Everything your workspace holds.'
					}
					currentHref={currentHref}
				/>
				{teamOrg && slug ? (
					<AccountManagementPanel
						title={`@${slug} has its own home`}
						description="Team organizations list their sections on the organization home."
					>
						<a
							href={routes.profile.href({ username: slug })}
							mix={css({
								...getGhostButtonCss({ size: 'sm' }),
								width: 'fit-content',
							})}
						>
							Open @{slug}
						</a>
					</AccountManagementPanel>
				) : (
					groups.map((group) => (
						<AccountManagementPanel key={group.label} title={group.label}>
							<ul
								aria-label={group.label}
								data-testid={`org-overview-${group.label.toLowerCase()}`}
								mix={css(cardGridCss)}
							>
								{group.items.map(renderCard)}
							</ul>
						</AccountManagementPanel>
					))
				)}
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
