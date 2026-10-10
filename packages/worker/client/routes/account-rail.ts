import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	accountAliasPath,
	orgBillingPath,
	orgCollaboratorsPath,
	orgGrantsPath,
	orgMembersPath,
	orgResourcePath,
	orgRoleManagesBilling,
	orgSettingsPath,
	orgTeamsPath,
	orgSlugFromPathname,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { type IconName } from '#universal/icon.tsx'

/**
 * The repository list for an organization. `/account/packages` only 302s
 * there, so it is the fallback when the session has no org slug yet.
 */
export function accountPackagesNavHref(orgSlug: string | null | undefined) {
	return orgSlug
		? orgResourcePath(orgSlug, 'packages')
		: routes.accountPackages.href()
}

function orgSectionHref(
	orgSlug: string | null | undefined,
	section: OrgOwnedAccountSection,
	fallback: string,
) {
	return orgSlug ? orgResourcePath(orgSlug, section) : fallback
}

/**
 * Org slug for workspace-rail links: the org already in the URL when the
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

export type AccountRailItem = {
	href: string
	label: string
	icon: IconName
	/** Other pages that belong to this item (`/account/passkeys` → Security). */
	alsoActiveFor?: ReadonlyArray<string>
}

export type AccountRailGroup = {
	label: string | null
	items: Array<AccountRailItem>
}

/** Settings that belong to the person, whichever organization they are in. */
const accountRailItems: Array<AccountRailItem> = [
	{ href: routes.account.href(), label: 'Profile', icon: 'user' },
	{
		href: routes.accountSecurity.href(),
		label: 'Security',
		icon: 'shield',
		alsoActiveFor: [
			routes.accountTwoFactor.href(),
			routes.accountPasskeys.href(),
		],
	},
	{
		href: routes.accountOrganizations.href(),
		label: 'Organizations',
		icon: 'users',
	},
	{
		href: routes.accountExperiments.href(),
		label: 'Experiments',
		icon: 'star',
	},
	{
		href: routes.accountData.href(),
		label: 'Data & deletion',
		icon: 'folder',
	},
]

/** True for the person-scoped pages that take the account rail. */
export function isAccountRailPath(pathname: string) {
	return accountRailItems.some((item) => isAccountNavItemActive(item, pathname))
}

export function accountRailGroups(): Array<AccountRailGroup> {
	return [{ label: null, items: accountRailItems }]
}

function billingRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgBillingPath(orgSlug) : routes.accountBilling.href(),
		label: 'Billing',
		icon: 'wallet',
	}
}

/**
 * Management links for a team (non-personal) organization. Same order as the
 * Organization rail: Settings, Members, Teams (owners/members), Grants,
 * Collaborators, Billing (owners/billing). Empty for collaborators (`role`
 * null) or when `orgSlug` is missing. Used by the rail, org switcher, and org
 * home so discovery stays consistent.
 */
export function teamOrgManagementItems(input: {
	orgSlug: string | null | undefined
	role: OrgRole | null
}): Array<AccountRailItem> {
	const { orgSlug } = input
	if (!orgSlug || input.role === null) return []
	const items: Array<AccountRailItem> = [
		{
			href: orgSettingsPath(orgSlug),
			label: 'Settings',
			icon: 'edit',
		},
		{
			href: orgMembersPath(orgSlug),
			label: 'Members',
			icon: 'users',
		},
	]
	// Billing has member:read but not team:read.
	if (input.role === 'owner' || input.role === 'member') {
		items.push({
			href: orgTeamsPath(orgSlug),
			label: 'Teams',
			icon: 'users',
		})
	}
	items.push(
		{
			href: orgGrantsPath(orgSlug),
			label: 'Grants',
			icon: 'key',
		},
		{
			href: orgCollaboratorsPath(orgSlug),
			label: 'Collaborators',
			icon: 'share',
		},
	)
	if (orgRoleManagesBilling(input.role)) {
		items.push(billingRailItem(orgSlug))
	}
	return items
}

/**
 * The workspace rail: everything the organization owns, grouped by job.
 * Team orgs get the Organization management links. Personal orgs keep the
 * Build / Access / Data / Activity groups (packages and connections still key
 * on the person; other sections read `request.org.id`).
 */
export function workspaceRailGroups(input: {
	orgSlug: string | null | undefined
	/** True when `orgSlug` is the signup (personal) organization. */
	personal: boolean
	role: OrgRole | null
}): Array<AccountRailGroup> {
	const { orgSlug } = input
	if (!input.personal) {
		const items = teamOrgManagementItems({
			orgSlug,
			role: input.role,
		})
		return items.length > 0 ? [{ label: 'Organization', items }] : []
	}
	return [
		{
			label: 'Build',
			items: [
				{
					href: accountPackagesNavHref(orgSlug),
					label: 'Repositories',
					icon: 'box',
				},
				{
					href: orgSectionHref(orgSlug, 'jobs', routes.accountJobs.href()),
					label: 'Jobs',
					icon: 'briefcase',
				},
				{
					href: orgSectionHref(
						orgSlug,
						'workflows',
						routes.accountWorkflows.href(),
					),
					label: 'Workflows',
					icon: 'refresh',
				},
				{
					href: orgSectionHref(
						orgSlug,
						'webhooks',
						routes.accountWebhooks.href(),
					),
					label: 'Webhooks',
					icon: 'cloud',
				},
			],
		},
		{
			label: 'Access',
			items: [
				{
					href: orgSectionHref(
						orgSlug,
						'connections',
						routes.accountConnections.href(),
					),
					label: 'Connections',
					icon: 'link',
					alsoActiveFor: [routes.accountMcpOauthClients.href()],
				},
				{
					href: orgSectionHref(
						orgSlug,
						'integrations',
						routes.accountIntegrations.href(),
					),
					label: 'Integrations',
					icon: 'plug',
				},
				{
					href: orgSectionHref(
						orgSlug,
						'mcp-servers',
						routes.accountMcpServers.href(),
					),
					label: 'MCP servers',
					icon: 'server',
				},
			],
		},
		{
			label: 'Data',
			items: [
				{
					href: orgSectionHref(
						orgSlug,
						'secrets',
						routes.accountSecrets.href(),
					),
					label: 'Secrets',
					icon: 'key',
				},
				{
					href: orgSectionHref(
						orgSlug,
						'secret-providers',
						routes.accountSecretProviders.href(),
					),
					label: 'Secret providers',
					icon: 'key',
				},
				{
					href: orgSectionHref(
						orgSlug,
						'memories',
						routes.accountMemories.href(),
					),
					label: 'Memories',
					icon: 'book',
				},
				{
					href: orgSectionHref(orgSlug, 'email', routes.accountEmail.href()),
					label: 'Email',
					icon: 'mail',
				},
			],
		},
		{
			label: 'Activity',
			items: [
				{
					href: orgSectionHref(
						orgSlug,
						'activity',
						routes.accountActivity.href(),
					),
					label: 'Activity',
					icon: 'trending-up',
				},
				{
					href: orgSectionHref(
						orgSlug,
						'waiting',
						routes.accountWaiting.href(),
					),
					label: 'Waiting',
					icon: 'clock',
				},
			],
		},
		{
			label: 'Organization',
			items: [
				billingRailItem(orgSlug),
				{
					href: routes.accountUsage.href(),
					label: 'Usage',
					icon: 'chart',
					alsoActiveFor: [routes.accountCredits.href()],
				},
			],
		},
	]
}

function matchesRailPath(itemPath: string, currentPath: string) {
	if (itemPath === routes.account.href()) return currentPath === itemPath
	const itemAlias = accountAliasPath(itemPath)
	const currentAlias = accountAliasPath(currentPath)
	return currentAlias === itemAlias || currentAlias.startsWith(`${itemAlias}/`)
}

export function isAccountNavItemActive(
	item: Pick<AccountRailItem, 'href' | 'alsoActiveFor'>,
	currentPath: string,
) {
	return [item.href, ...(item.alsoActiveFor ?? [])].some((path) =>
		matchesRailPath(path, currentPath),
	)
}
