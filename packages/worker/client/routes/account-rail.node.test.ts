import { expect, test } from 'vitest'
import {
	accountPackagesNavHref,
	accountRailGroups,
	accountRailOrgSlug,
	isAccountNavItemActive,
	isAccountRailPath,
	railTabsForPath,
	workspaceHomeHref,
	workspaceLandingItem,
	workspaceRailGroups,
	workspaceSwitchHref,
} from '#client/routes/account-rail.ts'
import { type OrganizationSummary } from '#universal/org-pages.ts'

const organizations: Array<OrganizationSummary> = [
	{ slug: 'acme', displayName: 'Acme', role: 'owner', personal: false },
	{ slug: 'jane-old', displayName: 'Jane', role: 'owner', personal: true },
]

test('account rail holds the person: profile, security, usage, organizations, experiments, data', () => {
	const items = accountRailGroups({ organizations: [] }).flatMap(
		(group) => group.items,
	)
	expect(items.map((item) => item.label)).toEqual([
		'Profile',
		'Security',
		'Usage & credits',
		'Organizations',
		'Experiments',
		'Data & deletion',
	])
	const security = items.find((item) => item.label === 'Security')
	expect(
		security && isAccountNavItemActive(security, '/account/passkeys'),
	).toBe(true)
	const usage = items.find((item) => item.label === 'Usage & credits')
	expect(usage && isAccountNavItemActive(usage, '/account/credits')).toBe(true)
	const profile = items.find((item) => item.label === 'Profile')
	expect(profile && isAccountNavItemActive(profile, '/account/security')).toBe(
		false,
	)
	for (const path of [
		'/account',
		'/account/security',
		'/account/two-factor',
		'/account/passkeys',
		'/account/usage',
		'/account/credits',
		'/account/organizations',
		'/account/organizations/new',
		'/account/experiments',
		'/account/data',
	]) {
		expect(isAccountRailPath(path), path).toBe(true)
	}
	for (const path of [
		'/account/billing',
		'/account/mcp-oauth-clients',
		'/@jane/-/secrets',
		'/@jane/-/repositories',
	]) {
		expect(isAccountRailPath(path), path).toBe(false)
	}
})

test('account rail lists every workspace, signup org first, each opening its home', () => {
	const groups = accountRailGroups({ organizations })
	expect(groups.map((group) => group.label)).toEqual([null, 'Workspaces'])
	expect(
		groups[1]?.items.map((item) => [item.label, item.href, item.icon]),
	).toEqual([
		['@jane-old', '/@jane-old/-/overview', 'user'],
		['@acme', '/@acme', 'users'],
	])
	for (const item of groups[1]?.items ?? []) {
		expect(isAccountRailPath(item.href), item.href).toBe(false)
		expect(isAccountNavItemActive(item, '/account'), item.href).toBe(false)
	}
})

test('workspace home is the overview for the signup org and /@slug for a team', () => {
	expect(workspaceHomeHref({ slug: 'jane', personal: true })).toBe(
		'/@jane/-/overview',
	)
	expect(workspaceHomeHref({ slug: 'acme', personal: false })).toBe('/@acme')
})

test('workspace landing opens Repositories so the rail is one click away', () => {
	expect(workspaceLandingItem('jane')).toEqual({
		href: '/@jane/-/repositories',
		label: 'Workspace',
		icon: 'box',
	})
	expect(workspaceLandingItem(null).href).toBe('/account')
})

test('workspace rail groups what the organization owns and keeps its slug in every link', () => {
	const groups = workspaceRailGroups({
		orgSlug: 'jane',
		personal: true,
		role: 'owner',
	})
	const items = groups.flatMap((group) => group.items)
	expect(groups[0]).toEqual({
		label: null,
		items: [
			{
				href: '/@jane/-/overview',
				label: 'Overview',
				icon: 'home',
				description: 'Every section this workspace owns, one click away.',
			},
		],
	})
	const overview = items[0]
	expect(
		overview && isAccountNavItemActive(overview, '/@jane/-/overview'),
	).toBe(true)
	expect(overview && isAccountNavItemActive(overview, '/@jane/-/jobs')).toBe(
		false,
	)
	// Every section the overview page lists carries a one-line description.
	for (const item of groups.slice(1).flatMap((group) => group.items)) {
		expect(item.description, item.label).toBeTruthy()
	}
	expect(
		groups.map((group) => [group.label, group.items.map((item) => item.href)]),
	).toEqual([
		[null, ['/@jane/-/overview']],
		['Build', ['/@jane/-/repositories', '/@jane/-/jobs', '/@jane/-/webhooks']],
		[
			'Credentials',
			[
				'/@jane/-/secrets',
				'/@jane/-/integrations',
				'/@jane/-/mcp-servers',
				'/@jane/-/secret-providers',
			],
		],
		[
			'Agents & data',
			['/@jane/-/agents', '/@jane/-/memories', '/@jane/-/email'],
		],
		['Activity', ['/@jane/-/activity']],
		['Organization', ['/@jane/-/grants', '/@jane/-/billing']],
	])
	const billing = items.find((item) => item.label === 'Billing')
	expect(billing && isAccountNavItemActive(billing, '/@jane/-/billing')).toBe(
		true,
	)
	const connections = items.find((item) => item.label === 'Agents')
	expect(
		connections &&
			isAccountNavItemActive(connections, '/account/mcp-oauth-clients'),
	).toBe(true)
	expect(
		connections && isAccountNavItemActive(connections, '/@jane/-/agents/new'),
	).toBe(true)
	expect(accountPackagesNavHref(null)).toBe('/account')
})

test('activity lists workflows and waiting as tabs, so the rail names it once', () => {
	const groups = workspaceRailGroups({
		orgSlug: 'jane',
		personal: true,
		role: 'owner',
	})
	const activity = groups
		.flatMap((group) => group.items)
		.find((item) => item.label === 'Activity')
	for (const path of [
		'/@jane/-/activity',
		'/@jane/-/workflows',
		'/@jane/-/waiting',
	]) {
		expect(activity && isAccountNavItemActive(activity, path), path).toBe(true)
	}
	expect(railTabsForPath(groups, '/@jane/-/workflows')).toEqual({
		label: 'Activity',
		tabs: [
			{ href: '/@jane/-/activity', label: 'Activity', active: false },
			{ href: '/@jane/-/workflows', label: 'Workflows', active: true },
			{ href: '/@jane/-/waiting', label: 'Waiting', active: false },
		],
	})
	expect(railTabsForPath(groups, '/@jane/-/jobs')).toBeNull()
})

test('team organization rail shares the sections and keeps members, settings, and billing', () => {
	const teamRail = (role: 'owner' | 'member' | 'billing') =>
		workspaceRailGroups({ orgSlug: 'acme', personal: false, role })
	const teamOwner = teamRail('owner')
	expect(
		teamOwner.flatMap((group) => group.items).map((item) => item.label),
	).toEqual([
		'Overview',
		'Repositories',
		'Jobs',
		'Webhooks',
		'Secrets',
		'Integrations',
		'MCP servers',
		'Secret providers',
		'Agents',
		'Memories',
		'Email',
		'Activity',
		'Members',
		'Settings',
		'Billing',
	])
	expect(teamOwner.at(-1)?.items.map((item) => item.href)).toEqual([
		'/@acme/-/members',
		'/@acme/-/settings',
		'/@acme/-/billing',
	])
	expect(railTabsForPath(teamOwner, '/@acme/-/grants')?.tabs).toEqual([
		{ href: '/@acme/-/members', label: 'Members', active: false },
		{ href: '/@acme/-/teams', label: 'Teams', active: false },
		{ href: '/@acme/-/collaborators', label: 'Collaborators', active: false },
		{ href: '/@acme/-/grants', label: 'Grants', active: true },
	])
	// Billing has member:read but not team:read.
	expect(
		railTabsForPath(teamRail('billing'), '/@acme/-/members')?.tabs.map(
			(tab) => tab.label,
		),
	).toEqual(['Members', 'Collaborators', 'Grants'])
	expect(
		teamRail('billing')
			.at(-1)
			?.items.map((item) => item.label),
	).toEqual(['Members', 'Settings', 'Billing'])
	expect(
		teamRail('member')
			.at(-1)
			?.items.map((item) => item.label),
	).toEqual(['Members', 'Settings'])
	// Team Overview is the org home; exact match so section pages stay off.
	const teamOverview = teamOwner[0]?.items[0]
	expect(teamOverview?.href).toBe('/@acme')
	expect(teamOverview?.exact).toBe(true)
	expect(teamOverview && isAccountNavItemActive(teamOverview, '/@acme')).toBe(
		true,
	)
	expect(
		teamOverview &&
			isAccountNavItemActive(teamOverview, '/@acme/-/repositories'),
	).toBe(false)
	expect(
		teamOverview && isAccountNavItemActive(teamOverview, '/@acme/-/overview'),
	).toBe(true)
})

test('grant-only collaborators see Agents with a note, and no slug means no team rail', () => {
	const collaborator = workspaceRailGroups({
		orgSlug: 'acme',
		personal: false,
		role: null,
	})
	expect(
		collaborator.map((group) => [
			group.label,
			group.items.map((item) => item.href),
		]),
	).toEqual([['Agents & data', ['/@acme/-/agents']]])
	expect(collaborator[0]?.note).toMatch(/grant/i)
	expect(
		workspaceRailGroups({ orgSlug: null, personal: false, role: 'owner' }),
	).toEqual([])
})

test('switching workspaces keeps the page when the role can open it there', () => {
	const acmeOwner = { slug: 'acme', personal: false, role: 'owner' } as const
	const acmeBilling = { ...acmeOwner, role: 'billing' } as const
	const acmeGuest = { ...acmeOwner, role: null }
	const jane = { slug: 'jane', personal: true, role: 'owner' } as const
	expect(workspaceSwitchHref('/@jane/-/secrets', acmeOwner)).toBe(
		'/@acme/-/secrets',
	)
	expect(workspaceSwitchHref('/@acme/-/billing', jane)).toBe('/@jane/-/billing')
	expect(workspaceSwitchHref('/@jane/-/billing', acmeBilling)).toBe(
		'/@acme/-/billing',
	)
	expect(workspaceSwitchHref('/@acme/-/teams', acmeBilling)).toBe('/@acme')
	expect(workspaceSwitchHref('/@acme/-/settings', jane)).toBe(
		'/@jane/-/overview',
	)
	expect(workspaceSwitchHref('/@acme/-/grants', jane)).toBe('/@jane/-/grants')
	expect(workspaceSwitchHref('/@jane/-/agents', acmeGuest)).toBe(
		'/@acme/-/agents',
	)
	expect(workspaceSwitchHref('/@jane/-/secrets', acmeGuest)).toBe('/@acme')
	expect(workspaceSwitchHref('/@acme', jane)).toBe('/@jane/-/overview')
})

test('account rail org slug prefers the path org over username', () => {
	const summaries = [
		{ slug: 'ada-old', personal: true },
		{ slug: 'acme', personal: false },
	]
	expect(
		accountRailOrgSlug({
			pathname: '/@acme/-/jobs',
			organizations: summaries,
			username: 'ada-new',
		}),
	).toBe('acme')
	expect(
		accountRailOrgSlug({
			pathname: '/account',
			organizations: summaries,
			username: 'ada-new',
		}),
	).toBe('ada-old')
})

test('account rail org slug trusts org-owned URLs when the session list is stale', () => {
	expect(
		accountRailOrgSlug({
			pathname: '/@acme/-/settings',
			organizations: [{ slug: 'ada-old', personal: true }],
			username: 'ada-new',
		}),
	).toBe('acme')
	expect(
		accountRailOrgSlug({
			pathname: '/@acme/-/grants',
			organizations: [],
			username: 'ada-new',
		}),
	).toBe('acme')
})
