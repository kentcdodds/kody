import {
	accountAliasPath,
	orgResourcePath,
	orgSlugFromPathname,
	parseOrgResourcePath,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { type IconName } from '#universal/icon.tsx'

/**
 * Packages for the signup organization live on the public profile home
 * (`/@slug`). Non-personal org package lists use `/@slug/packages` (gated
 * until storage follows `request.org.id`). `/account/packages` only 302s
 * when the session has no org slug yet.
 */
export function accountPackagesNavHref(input: {
	orgSlug: string | null | undefined
	personal: boolean
}) {
	if (!input.orgSlug) return routes.accountPackages.href()
	return input.personal
		? routes.profile.href({ username: input.orgSlug })
		: orgResourcePath(input.orgSlug, 'packages')
}

function orgSectionHref(
	orgSlug: string | null | undefined,
	section: OrgOwnedAccountSection,
	fallback: string,
) {
	return orgSlug ? orgResourcePath(orgSlug, section) : fallback
}

/**
 * Org slug for account-rail links: the org already in the URL when the
 * person belongs to it, otherwise their signup organization. Username is
 * only a last resort — personal org slugs stay put across renames.
 */
export function accountRailOrgSlug(input: {
	pathname: string
	organizations: ReadonlyArray<{ slug: string; personal: boolean }>
	username: string | null | undefined
}) {
	const fromPath = orgSlugFromPathname(input.pathname)
	if (fromPath && input.organizations.some((org) => org.slug === fromPath)) {
		return fromPath
	}
	return (
		input.organizations.find((org) => org.personal)?.slug ??
		input.username?.trim() ??
		null
	)
}

type AccountNavItem = { href: string; label: string; icon: IconName }

/** Account rail items in display order for the signed-in session. */
export function accountNavItemsFor(input: {
	orgSlug: string | null | undefined
	/** True when `orgSlug` is the signup (personal) organization. */
	personal: boolean
	showShared: boolean
}): Array<AccountNavItem> {
	return [
		{ href: '/account', label: 'Overview', icon: 'home' },
		{
			href: orgSectionHref(input.orgSlug, 'waiting', '/account/waiting'),
			label: 'Waiting',
			icon: 'clock',
		},
		{ href: '/account/experiments', label: 'Experiments', icon: 'star' },
		{
			href: orgSectionHref(
				input.orgSlug,
				'connections',
				routes.accountConnections.href(),
			),
			label: 'Connections',
			icon: 'link',
		},
		{
			href: accountPackagesNavHref({
				orgSlug: input.orgSlug,
				personal: input.personal,
			}),
			label: 'Repositories',
			icon: 'box',
		},
		...(input.showShared
			? [
					{
						href: orgSectionHref(
							input.orgSlug,
							'shared',
							routes.accountShared.href(),
						),
						label: 'Shared',
						icon: 'share' as const,
					},
				]
			: []),
		{ href: '/account/billing', label: 'Billing', icon: 'wallet' },
		{ href: '/account/usage', label: 'Usage', icon: 'chart' },
		{
			href: orgSectionHref(input.orgSlug, 'activity', '/account/activity'),
			label: 'Activity',
			icon: 'trending-up',
		},
		{
			href: orgSectionHref(input.orgSlug, 'jobs', '/account/jobs'),
			label: 'Jobs',
			icon: 'briefcase',
		},
		{
			href: orgSectionHref(input.orgSlug, 'workflows', '/account/workflows'),
			label: 'Workflows',
			icon: 'refresh',
		},
		{
			href: orgSectionHref(
				input.orgSlug,
				'webhooks',
				routes.accountWebhooks.href(),
			),
			label: 'Webhooks',
			icon: 'cloud',
		},
		{
			href: orgSectionHref(input.orgSlug, 'secrets', '/account/secrets'),
			label: 'Secrets',
			icon: 'key',
		},
		{
			href: orgSectionHref(
				input.orgSlug,
				'secret-providers',
				'/account/secret-providers',
			),
			label: 'Secret providers',
			icon: 'key',
		},
		{
			href: orgSectionHref(
				input.orgSlug,
				'integrations',
				'/account/integrations',
			),
			label: 'Integrations',
			icon: 'plug',
		},
		{
			href: orgSectionHref(
				input.orgSlug,
				'mcp-servers',
				'/account/mcp-servers',
			),
			label: 'MCP servers',
			icon: 'server',
		},
		{
			href: orgSectionHref(input.orgSlug, 'memories', '/account/memories'),
			label: 'Memories',
			icon: 'book',
		},
		{
			href: orgSectionHref(input.orgSlug, 'email', '/account/email'),
			label: 'Email',
			icon: 'mail',
		},
	]
}

export function isAccountNavItemActive(itemHref: string, currentPath: string) {
	if (itemHref === '/account') return currentPath === '/account'
	// The repository list is `/@slug` (and package pages under it). Organization
	// sections such as `/@slug/secrets` are their own rail items.
	if (/^\/@[^/]+$/.test(itemHref)) {
		if (currentPath === itemHref) return true
		const orgPage = parseOrgResourcePath(currentPath)
		if (orgPage?.section === 'packages') return true
		if (orgPage) return false
		return currentPath.startsWith(`${itemHref}/`)
	}
	const itemAlias = accountAliasPath(itemHref)
	const currentAlias = accountAliasPath(currentPath)
	return currentAlias === itemAlias || currentAlias.startsWith(`${itemAlias}/`)
}
