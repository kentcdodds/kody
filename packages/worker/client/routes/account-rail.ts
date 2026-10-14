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
	orgUsagePath,
	orderOrganizations,
	parseOrgBillingPath,
	parseOrgManagementPath,
	parseOrgResourcePath,
	parseOrgUsagePath,
	switchOrgPath,
	type OrganizationSummary,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { type IconName } from '#universal/icon.tsx'

/**
 * The repository list for an organization. Without a slug yet, the link
 * opens the person hub instead of a removed `/account/packages` page.
 */
export function accountPackagesNavHref(orgSlug: string | null | undefined) {
	return orgSlug
		? orgResourcePath(orgSlug, 'repositories')
		: routes.account.href()
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

/** One page of a rail item that has several (Activity → Workflows). */
export type AccountRailTab = {
	href: string
	label: string
}

export type AccountRailItem = {
	href: string
	label: string
	icon: IconName
	/** Other pages that belong to this item (`/account/passkeys` → Security). */
	alsoActiveFor?: ReadonlyArray<string>
	/** One line for the workspace overview card. */
	description?: string
	/**
	 * When true, only an exact path match marks this item current. Used for a
	 * team Overview that lands on `/@slug` so `/@slug/-/repositories` does not
	 * light it up.
	 */
	exact?: boolean
	/**
	 * Sibling pages shown as tabs under the page title. Each tab page also
	 * marks this item current, so the rail lists the group once.
	 */
	tabs?: ReadonlyArray<AccountRailTab>
}

export type AccountRailGroup = {
	label: string | null
	items: Array<AccountRailItem>
	/**
	 * Short explanation when role permissions hide the rest of this group
	 * (grant-only collaborators). Shown in the rail; never used to hide a
	 * section that the server would open for a member role.
	 */
	note?: string
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
 * Where an organization's workspace opens: a team org's home at `/@slug`,
 * or the signup org's `/@slug/-/overview` (its `/@slug` is the public
 * profile).
 */
export function workspaceHomeHref(org: { slug: string; personal: boolean }) {
	return org.personal
		? orgOverviewPath(org.slug)
		: routes.profile.href({ username: org.slug })
}

/**
 * Whether `pathname` (already rewritten into `org`) is a page this role can
 * open there. Mirrors the server: grant-only collaborators open Agents
 * only, Billing needs `billing:write`, Teams needs `team:read`, and a
 * personal org has no Settings, Members, Teams, or Collaborators pages.
 */
function orgPathOpensFor(
	pathname: string,
	org: Pick<OrganizationSummary, 'personal' | 'role'>,
) {
	const section = parseOrgResourcePath(pathname)?.section
	if (org.role === null) return section === 'agents'
	if (parseOrgBillingPath(pathname) || parseOrgUsagePath(pathname)) {
		return orgRoleManagesBilling(org.role)
	}
	const management = parseOrgManagementPath(pathname)?.section
	if (!management) return true
	if (org.personal) return management === 'grants'
	if (management === 'teams') return org.role !== 'billing'
	return true
}

/**
 * Where the org switcher sends you: the same page in the target org when
 * you can open it there, otherwise that org's workspace home.
 */
export function workspaceSwitchHref(
	pathname: string,
	org: Pick<OrganizationSummary, 'slug' | 'personal' | 'role'>,
) {
	const next = switchOrgPath(pathname, org.slug)
	if (next === routes.profile.href({ username: org.slug })) {
		return workspaceHomeHref(org)
	}
	return orgPathOpensFor(next, org) ? next : workspaceHomeHref(org)
}

/**
 * The account rail: settings that belong to the person, then a Workspaces
 * group with one row per organization they belong to. Each row opens that
 * workspace, whose own rail lists every section, so any section is two
 * clicks from `/account`.
 */
export function accountRailGroups(input: {
	organizations: ReadonlyArray<OrganizationSummary>
}): Array<AccountRailGroup> {
	const person: AccountRailGroup = { label: null, items: accountRailItems }
	if (input.organizations.length === 0) return [person]
	return [
		person,
		{
			label: 'Workspaces',
			items: orderOrganizations(input.organizations).map((org) => ({
				href: workspaceHomeHref(org),
				label: `@${org.slug}`,
				icon: org.personal ? 'user' : 'users',
			})),
		},
	]
}

function overviewRailItem(
	orgSlug: string | null | undefined,
	personal = true,
): AccountRailItem {
	if (!orgSlug) {
		return {
			href: routes.account.href(),
			label: 'Overview',
			icon: 'home',
			description: 'Every section this workspace owns, one click away.',
		}
	}
	// Team orgs already use `/@slug` as their overview (the server redirects
	// `/-/overview` there). Link straight to the home so a refresh keeps it.
	if (!personal) {
		return {
			href: routes.profile.href({ username: orgSlug }),
			label: 'Overview',
			icon: 'home',
			description: 'Every section this workspace owns, one click away.',
			exact: true,
			alsoActiveFor: [orgOverviewPath(orgSlug)],
		}
	}
	return {
		href: orgOverviewPath(orgSlug),
		label: 'Overview',
		icon: 'home',
		description: 'Every section this workspace owns, one click away.',
	}
}

function billingRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgBillingPath(orgSlug) : routes.account.href(),
		label: 'Billing',
		icon: 'wallet',
	}
}

function usageRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgUsagePath(orgSlug) : routes.account.href(),
		label: 'Usage & credits',
		icon: 'chart',
		alsoActiveFor: orgSlug
			? [routes.accountUsage.href(), routes.accountCredits.href()]
			: [routes.accountCredits.href()],
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
 * null) or when `orgSlug` is missing. Used by the rail and org home so
 * discovery stays consistent.
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
		items.push(usageRailItem(orgSlug), billingRailItem(orgSlug))
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

function agentsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'agents'),
		label: 'Agents',
		icon: 'link',
		alsoActiveFor: [routes.accountMcpOauthClients.href()],
		description: 'Agents connected to Kody and what they can use.',
	}
}

/**
 * One home for every credential kind. The Key, OAuth, and MCP server editors
 * still live on their own pages, so those count as Credentials too.
 */
function credentialsRailItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'credentials'),
		label: 'Credentials',
		icon: 'key',
		alsoActiveFor: orgSlug
			? (['secrets', 'integrations', 'mcp-servers'] as const).map((section) =>
					orgResourcePath(orgSlug, section),
				)
			: [],
		description:
			'Keys, OAuth connections, MCP servers, and vaults Kody uses for you.',
	}
}

function memoriesRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'memories'),
		label: 'Memories',
		icon: 'book',
		description:
			'Personal long-term memories (team workspaces show a read-only legacy list).',
	}
}

function activityRailItem(orgSlug: string | null | undefined): AccountRailItem {
	const tabs: Array<AccountRailTab> = [
		{ href: orgSectionHref(orgSlug, 'activity'), label: 'Activity' },
		{ href: orgSectionHref(orgSlug, 'workflows'), label: 'Workflows' },
		{ href: orgSectionHref(orgSlug, 'waiting'), label: 'Waiting' },
	]
	return {
		href: orgSectionHref(orgSlug, 'activity'),
		label: 'Activity',
		icon: 'trending-up',
		alsoActiveFor: tabs.slice(1).map((tab) => tab.href),
		description:
			'Recent runs with their logs, long-running workflows, and what is waiting on you.',
		tabs,
	}
}

function grantsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgGrantsPath(orgSlug) : routes.account.href(),
		label: 'Grants',
		icon: 'key',
		description: 'Who can use packages and other resources in this workspace.',
	}
}

/**
 * Members of a team org, with Teams, Collaborators, and Grants as tabs. Teams
 * needs `team:read`, which the Billing role does not have.
 */
function membersRailItem(orgSlug: string, role: OrgRole): AccountRailItem {
	const tabs: Array<AccountRailTab> = [
		{ href: orgMembersPath(orgSlug), label: 'Members' },
		...(role === 'owner' || role === 'member'
			? [{ href: orgTeamsPath(orgSlug), label: 'Teams' }]
			: []),
		{ href: orgCollaboratorsPath(orgSlug), label: 'Collaborators' },
		{ href: orgGrantsPath(orgSlug), label: 'Grants' },
	]
	return {
		href: orgMembersPath(orgSlug),
		label: 'Members',
		icon: 'users',
		alsoActiveFor: tabs.slice(1).map((tab) => tab.href),
		description: 'People, teams, collaborators, and what each can use.',
		tabs,
	}
}

/**
 * Sections every organization has, in the same order for personal and team
 * orgs. The server opens each of them for member roles (`orgSectionDenial`
 * only closes grant-only collaborators). Credentials are one group: the
 * kinds of thing Kody uses on your behalf, plus the vaults they can come from.
 */
function workspaceResourceGroups(
	orgSlug: string | null | undefined,
): Array<AccountRailGroup> {
	return [
		{
			label: 'Build',
			items: [
				repositoriesRailItem(orgSlug),
				jobsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'webhooks'),
					label: 'Webhooks',
					icon: 'cloud',
					description: 'Every inbound webhook your packages declare.',
				},
			],
		},
		{
			label: 'Credentials',
			items: [
				credentialsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'secret-providers'),
					label: 'Secret providers',
					icon: 'lock',
					description: 'Bind a package to a provider such as 1password.',
				},
			],
		},
		{
			label: 'Agents & data',
			items: [
				agentsRailItem(orgSlug),
				memoriesRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'email'),
					label: 'Email',
					icon: 'mail',
					description:
						'This workspace inbox and the addresses Kody may send from.',
				},
			],
		},
		{ label: 'Activity', items: [activityRailItem(orgSlug)] },
	]
}

/**
 * The workspace rail: everything the organization owns, grouped by job.
 * Personal and team orgs share every section above Organization. A team
 * org's Organization group holds Members (with Teams, Collaborators, and
 * Grants as tabs), Settings, and Billing for roles that manage it. A
 * personal org has no members or settings of its own (its name and photo
 * are the person's profile), so it lists Grants and Billing. Grant-only
 * collaborators (`role` null) get Agents only, with a note.
 */
export function workspaceRailGroups(input: {
	orgSlug: string | null | undefined
	/** True when `orgSlug` is the signup (personal) organization. */
	personal: boolean
	role: OrgRole | null
}): Array<AccountRailGroup> {
	const { orgSlug, personal, role } = input
	// Team chrome needs a slug. A missing signup slug still lists the
	// personal-shaped sections with `/account` fallbacks until one exists.
	if (!orgSlug && !personal) return []

	if (role === null) {
		if (!orgSlug) return []
		return [
			{
				label: 'Agents & data',
				items: [agentsRailItem(orgSlug)],
				note: 'Only Agents is available with a grant. Ask an owner for membership to open the rest of this workspace.',
			},
		]
	}

	const usage: AccountRailItem = {
		...usageRailItem(orgSlug),
		description: 'Activity, included compute, plan limits, and credits.',
	}
	const billing: AccountRailItem = {
		...billingRailItem(orgSlug),
		description: 'Plan, subscription, and payment method.',
	}
	const billingAndUsage = orgRoleManagesBilling(role) ? [usage, billing] : []
	const organizationItems: Array<AccountRailItem> =
		personal || !orgSlug
			? [grantsRailItem(orgSlug), ...billingAndUsage]
			: [
					membersRailItem(orgSlug, role),
					{
						href: orgSettingsPath(orgSlug),
						label: 'Settings',
						icon: 'edit',
						description: 'The organization name, photo, and deletion.',
					},
					...billingAndUsage,
				]

	return [
		...(orgSlug
			? [{ label: null, items: [overviewRailItem(orgSlug, personal)] }]
			: []),
		...workspaceResourceGroups(orgSlug),
		{ label: 'Organization', items: organizationItems },
	]
}

/**
 * Tabs for the page at `currentPath`: those of the rail item it belongs to
 * (named by that item), or null when that item has a single page.
 */
export function railTabsForPath(
	groups: ReadonlyArray<AccountRailGroup>,
	currentPath: string,
): {
	label: string
	tabs: Array<AccountRailTab & { active: boolean }>
} | null {
	const item = groups
		.flatMap((group) => group.items)
		.find((entry) => entry.tabs && isAccountNavItemActive(entry, currentPath))
	if (!item?.tabs) return null
	return {
		label: item.label,
		tabs: item.tabs.map((tab) => ({
			...tab,
			active: matchesRailPath(tab.href, currentPath),
		})),
	}
}

function matchesRailPath(itemPath: string, currentPath: string) {
	if (itemPath === routes.account.href()) return currentPath === itemPath
	const itemAlias = accountAliasPath(itemPath)
	const currentAlias = accountAliasPath(currentPath)
	return currentAlias === itemAlias || currentAlias.startsWith(`${itemAlias}/`)
}

export function isAccountNavItemActive(
	item: Pick<AccountRailItem, 'href' | 'alsoActiveFor' | 'exact'>,
	currentPath: string,
) {
	const normalized =
		currentPath.length > 1 ? currentPath.replace(/\/+$/, '') : currentPath
	if (item.exact) {
		const href =
			item.href.length > 1 ? item.href.replace(/\/+$/, '') : item.href
		if (normalized === href) return true
		return (item.alsoActiveFor ?? []).some((path) =>
			matchesRailPath(path, currentPath),
		)
	}
	return [item.href, ...(item.alsoActiveFor ?? [])].some((path) =>
		matchesRailPath(path, currentPath),
	)
}
