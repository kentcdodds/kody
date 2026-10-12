import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	accountAliasPath,
	orgBillingPath,
	orgCollaboratorsPath,
	orgGrantsPath,
	orgMembersPath,
	orgOverviewPath,
	orgResourcePath,
	orgRoleManagesBilling,
	orgSettingsPath,
	orgTeamsPath,
	orgSlugFromOrgOwnedPath,
	orgSlugFromPathname,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { type IconName } from '#universal/icon.tsx'

/**
 * The repository list for an organization. Without a slug yet, the link
 * opens the person hub instead of a removed `/account/packages` page.
 */
export function accountPackagesNavHref(orgSlug: string | null | undefined) {
	return orgSlug ? orgResourcePath(orgSlug, 'packages') : routes.account.href()
}

function orgSectionHref(
	orgSlug: string | null | undefined,
	section: OrgOwnedAccountSection,
) {
	return orgSlug ? orgResourcePath(orgSlug, section) : routes.account.href()
}

/**
 * Org slug for workspace-rail links: the org already on an org-owned
 * `/@slug/-/…` URL (even when the session list is stale), otherwise the org
 * in the path when the person belongs to it, otherwise their signup
 * organization. Username is only a last resort — personal org slugs stay put
 * across renames.
 */
export function accountRailOrgSlug(input: {
	pathname: string
	organizations: ReadonlyArray<{ slug: string; personal: boolean }>
	username: string | null | undefined
}) {
	const ownedPathSlug = orgSlugFromOrgOwnedPath(input.pathname)
	if (ownedPathSlug) return ownedPathSlug
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
	/** One line for the workspace overview card. */
	description?: string
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

/**
 * The account rail: person settings, then a Workspace group that opens what
 * the person's own organization holds (everything that lived under `/account`
 * before organizations). Overview links the rest of the workspace.
 */
export function accountRailGroups(input: {
	workspaceSlug: string | null | undefined
}): Array<AccountRailGroup> {
	const person: AccountRailGroup = { label: null, items: accountRailItems }
	const slug = input.workspaceSlug
	if (!slug) return [person]
	return [
		person,
		{
			label: 'Workspace',
			items: [
				overviewRailItem(slug),
				repositoriesRailItem(slug),
				connectionsRailItem(slug),
				mcpServersRailItem(slug),
				secretsRailItem(slug),
				jobsRailItem(slug),
				memoriesRailItem(slug),
			],
		},
	]
}

function overviewRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgOverviewPath(orgSlug) : routes.account.href(),
		label: 'Overview',
		icon: 'home',
	}
}

function billingRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgBillingPath(orgSlug) : routes.account.href(),
		label: 'Billing',
		icon: 'wallet',
	}
}

/**
 * Entry into an organization's workspace rail. Lands on Repositories (the
 * first Build section) so Activity, Secrets, and the rest stay one click away
 * on the existing `/@slug/-/<section>` rail — not a second navigation system.
 */
export function workspaceLandingItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: accountPackagesNavHref(orgSlug),
		label: 'Workspace',
		icon: 'box',
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

function repositoriesRailItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: accountPackagesNavHref(orgSlug),
		label: 'Repositories',
		icon: 'box',
		description: 'Every repository in this workspace, private ones included.',
	}
}

function jobsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'jobs'),
		label: 'Jobs',
		icon: 'briefcase',
		description: 'Scheduled package jobs. Run one now or pause it.',
	}
}

function connectionsRailItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'connections'),
		label: 'Connections',
		icon: 'link',
		alsoActiveFor: [routes.accountMcpOauthClients.href()],
		description: 'Agents connected to Kody and what they can use.',
	}
}

function mcpServersRailItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'mcp-servers'),
		label: 'MCP servers',
		icon: 'server',
		description: 'Remote MCP servers whose tools Kody can call.',
	}
}

function secretsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'secrets'),
		label: 'Secrets',
		icon: 'key',
		description: 'API keys and tokens your packages use.',
	}
}

function memoriesRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'memories'),
		label: 'Memories',
		icon: 'book',
		description: 'Long-term memories Kody keeps for you.',
	}
}

/**
 * The workspace rail: everything the organization owns, grouped by job.
 * Personal orgs get Overview and every Build / Access / Data / Activity
 * section. Team orgs get the sections `/@slug/-/<section>` opens for them:
 * Repositories, Jobs, Connections, and Secrets for every member role, above
 * the Organization management links. Grant-only collaborators (`role` null)
 * get Connections only, which is how they use what was shared with them.
 */
export function workspaceRailGroups(input: {
	orgSlug: string | null | undefined
	/** True when `orgSlug` is the signup (personal) organization. */
	personal: boolean
	role: OrgRole | null
}): Array<AccountRailGroup> {
	const { orgSlug } = input
	if (!input.personal) {
		if (!orgSlug) return []
		if (input.role === null) {
			return [{ label: 'Access', items: [connectionsRailItem(orgSlug)] }]
		}
		return [
			{
				label: 'Build',
				items: [repositoriesRailItem(orgSlug), jobsRailItem(orgSlug)],
			},
			{ label: 'Access', items: [connectionsRailItem(orgSlug)] },
			{ label: 'Data', items: [secretsRailItem(orgSlug)] },
			{
				label: 'Organization',
				items: teamOrgManagementItems({ orgSlug, role: input.role }),
			},
		]
	}
	return [
		...(orgSlug ? [{ label: null, items: [overviewRailItem(orgSlug)] }] : []),
		{
			label: 'Build',
			items: [
				repositoriesRailItem(orgSlug),
				jobsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'workflows'),
					label: 'Workflows',
					icon: 'refresh',
					description: 'Deferred and long-running workflow runs.',
				},
				{
					href: orgSectionHref(orgSlug, 'webhooks'),
					label: 'Webhooks',
					icon: 'cloud',
					description: 'Every inbound webhook your packages declare.',
				},
			],
		},
		{
			label: 'Access',
			items: [
				connectionsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'integrations'),
					label: 'Integrations',
					icon: 'plug',
					description: 'Services you connect so Kody can use them.',
				},
				mcpServersRailItem(orgSlug),
			],
		},
		{
			label: 'Data',
			items: [
				secretsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'secret-providers'),
					label: 'Secret providers',
					icon: 'key',
					description: 'Bind a package to a provider such as 1password.',
				},
				memoriesRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'email'),
					label: 'Email',
					icon: 'mail',
					description:
						'Your platform inbox and the addresses Kody may send from.',
				},
			],
		},
		{
			label: 'Activity',
			items: [
				{
					href: orgSectionHref(orgSlug, 'activity'),
					label: 'Activity',
					icon: 'trending-up',
					description: 'Failures first, then recent runs with their logs.',
				},
				{
					href: orgSectionHref(orgSlug, 'waiting'),
					label: 'Waiting',
					icon: 'clock',
					description: 'Things that need you.',
				},
			],
		},
		{
			label: 'Organization',
			items: [
				{
					...billingRailItem(orgSlug),
					description: 'Plan, subscription, and payment method.',
				},
				{
					href: routes.accountUsage.href(),
					label: 'Usage',
					icon: 'chart',
					alsoActiveFor: [routes.accountCredits.href()],
					description: 'Included compute, plan limits, and credits.',
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
