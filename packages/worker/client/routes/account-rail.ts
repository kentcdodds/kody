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
		description: 'Long-term memories Kody keeps for this workspace.',
	}
}

function usageRailItem(): AccountRailItem {
	return {
		href: routes.accountUsage.href(),
		label: 'Usage',
		icon: 'chart',
		alsoActiveFor: [routes.accountCredits.href()],
		description:
			'Your personal compute usage, plan limits, and credits (not scoped to this organization).',
	}
}

/**
 * Shared Build / Access / Data / Activity sections. Personal and team orgs
 * use the same list; the server opens every section for member roles
 * (`orgSectionDenial` only closes grant-only collaborators).
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
						'This workspace inbox and the addresses Kody may send from.',
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
	]
}

/**
 * The workspace rail: everything the organization owns, grouped by job.
 * Personal and team orgs share the same Build / Access / Data / Activity
 * sections (and Overview). Organization links differ by kind: signup orgs
 * get Billing + Usage; team orgs get Settings / Members / … (role-filtered)
 * plus the same person-scoped Usage link. Grant-only collaborators
 * (`role` null) get Connections only, with a short note explaining why.
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
				label: 'Access',
				items: [connectionsRailItem(orgSlug)],
				note: 'Only Connections is available with a grant. Ask an owner for membership to open the rest of this workspace.',
			},
		]
	}

	const organizationItems: Array<AccountRailItem> = personal
		? [
				{
					href: orgSlug ? orgGrantsPath(orgSlug) : routes.account.href(),
					label: 'Grants',
					icon: 'key',
					description:
						'Who can use packages and other resources in this workspace.',
				},
				{
					...billingRailItem(orgSlug),
					description: 'Plan, subscription, and payment method.',
				},
				usageRailItem(),
			]
		: [...teamOrgManagementItems({ orgSlug, role }), usageRailItem()]

	return [
		...(orgSlug
			? [{ label: null, items: [overviewRailItem(orgSlug, personal)] }]
			: []),
		...workspaceResourceGroups(orgSlug),
		{ label: 'Organization', items: organizationItems },
	]
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
