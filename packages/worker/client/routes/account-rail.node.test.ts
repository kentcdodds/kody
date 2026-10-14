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

test('account rail holds the person: profile, security, organizations, experiments, data', () => {
	const items = accountRailGroups().flatMap((group) => group.items)
	expect(items.map((item) => item.label)).toEqual([
		'Profile',
		'Security',
		'Organizations',
		'Experiments',
		'Data & deletion',
	])
	const security = items.find((item) => item.label === 'Security')
	expect(
		security && isAccountNavItemActive(security, '/account/passkeys'),
	).toBe(true)
	const profile = items.find((item) => item.label === 'Profile')
	expect(profile && isAccountNavItemActive(profile, '/account/security')).toBe(
		false,
	)
	for (const path of [
		'/account',
		'/account/security',
		'/account/two-factor',
		'/account/passkeys',
		'/account/organizations',
		'/account/organizations/new',
		'/account/experiments',
		'/account/data',
	]) {
		expect(isAccountRailPath(path), path).toBe(true)
	}
	for (const path of [
		'/account/billing',
		'/account/usage',
		'/account/credits',
		'/account/mcp-oauth-clients',
		'/@jane/-/secrets',
		'/@jane/-/repositories',
		'/@jane/-/usage',
	]) {
		expect(isAccountRailPath(path), path).toBe(false)
	}
})

test('account rail has no workspaces group; orgs live in the avatar menu', () => {
	const groups = accountRailGroups()
	expect(groups.map((group) => group.label)).toEqual([null])
	expect(
		groups
			.flatMap((group) => group.items)
			.some((item) => item.label.startsWith('@')),
	).toBe(false)
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
	expect(
		groups.map((group) => [group.label, group.items.map((item) => item.href)]),
	).toEqual([
		[null, ['/@jane/-/overview']],
		['Build', ['/@jane/-/repositories', '/@jane/-/jobs', '/@jane/-/webhooks']],
		['Credentials', ['/@jane/-/credentials', '/@jane/-/secret-providers']],
		[
			'Agents & data',
			['/@jane/-/agents', '/@jane/-/memories', '/@jane/-/email'],
		],
		['Activity', ['/@jane/-/activity']],
		[
			'Organization',
			[
				'/@jane/-/grants',
				'/@jane/-/usage',
				'/@jane/-/credits',
				'/@jane/-/billing',
			],
		],
	])
	// The Key, OAuth, and MCP server editors still count as Credentials.
	const credentials = items.find((item) => item.label === 'Credentials')
	for (const path of [
		'/@jane/-/credentials',
		'/@jane/-/secrets/user/OPENAI_API_KEY',
		'/@jane/-/integrations/github',
		'/@jane/-/mcp-servers/new',
	]) {
		expect(credentials && isAccountNavItemActive(credentials, path), path).toBe(
			true,
		)
	}
	expect(
		credentials &&
			isAccountNavItemActive(credentials, '/@jane/-/secret-providers'),
	).toBe(false)
	const usage = items.find((item) => item.label === 'Usage')
	expect(usage && isAccountNavItemActive(usage, '/@jane/-/usage')).toBe(true)
	expect(usage && isAccountNavItemActive(usage, '/account/usage')).toBe(true)
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
		'Credentials',
		'Secret providers',
		'Agents',
		'Email',
		'Activity',
		'Members',
		'Settings',
		'Usage',
		'Credits',
		'Billing',
	])
	expect(
		teamOwner.flatMap((group) => group.items).map((item) => item.label),
	).not.toContain('Memories')
	expect(teamOwner.at(-1)?.items.map((item) => item.href)).toEqual([
		'/@acme/-/members',
		'/@acme/-/settings',
		'/@acme/-/usage',
		'/@acme/-/credits',
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
	).toEqual(['Members', 'Settings', 'Usage', 'Credits', 'Billing'])
	// Members cannot open usage or billing, but Credits shows their budget.
	expect(
		teamRail('member')
			.at(-1)
			?.items.map((item) => [item.label, item.description]),
	).toEqual([
		['Members', expect.any(String)],
		['Settings', expect.any(String)],
		['Credits', 'Your monthly budget and what it has spent.'],
	])
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

test('personal rail includes Memories; team rail hides it (ADR 0072)', () => {
	const sections = (personal: boolean) =>
		workspaceRailGroups({ orgSlug: 'acme', personal, role: 'owner' })
			.filter((group) => group.label !== 'Organization')
			.map((group) => [group.label, group.items.map((item) => item.label)])
	expect(sections(true)).toEqual([
		[null, ['Overview']],
		['Build', ['Repositories', 'Jobs', 'Webhooks']],
		['Credentials', ['Credentials', 'Secret providers']],
		['Agents & data', ['Agents', 'Memories', 'Email']],
		['Activity', ['Activity']],
	])
	expect(sections(false)).toEqual([
		[null, ['Overview']],
		['Build', ['Repositories', 'Jobs', 'Webhooks']],
		['Credentials', ['Credentials', 'Secret providers']],
		['Agents & data', ['Agents', 'Email']],
		['Activity', ['Activity']],
	])
	for (const role of ['owner', 'member', 'billing'] as const) {
		expect(
			workspaceRailGroups({ orgSlug: 'acme', personal: false, role })
				.filter((group) => group.label !== 'Organization')
				.map((group) => [group.label, group.items.map((item) => item.label)]),
			role,
		).toEqual(sections(false))
	}
})

test('grant-only collaborators see Agents and Credits with a note, and no slug means no team rail', () => {
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
	).toEqual([
		['Agents & data', ['/@acme/-/agents']],
		['Organization', ['/@acme/-/credits']],
	])
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
	expect(workspaceSwitchHref('/@jane/-/usage', acmeOwner)).toBe(
		'/@acme/-/usage',
	)
	expect(workspaceSwitchHref('/@jane/-/usage', acmeBilling)).toBe(
		'/@acme/-/usage',
	)
	expect(workspaceSwitchHref('/@acme/-/usage', jane)).toBe('/@jane/-/usage')
	expect(workspaceSwitchHref('/@acme/-/teams', acmeBilling)).toBe('/@acme')
	expect(workspaceSwitchHref('/@acme/-/settings', jane)).toBe(
		'/@jane/-/overview',
	)
	expect(workspaceSwitchHref('/@acme/-/grants', jane)).toBe('/@jane/-/grants')
	expect(workspaceSwitchHref('/@jane/-/agents', acmeGuest)).toBe(
		'/@acme/-/agents',
	)
	expect(workspaceSwitchHref('/@jane/-/secrets', acmeGuest)).toBe('/@acme')
	expect(workspaceSwitchHref('/@jane/-/usage', acmeGuest)).toBe('/@acme')
	const acmeMember = { ...acmeOwner, role: 'member' } as const
	expect(workspaceSwitchHref('/@jane/-/usage', acmeMember)).toBe('/@acme')
	expect(workspaceSwitchHref('/@jane/-/credits', acmeMember)).toBe(
		'/@acme/-/credits',
	)
	expect(workspaceSwitchHref('/@acme/-/credits', jane)).toBe('/@jane/-/credits')
	expect(workspaceSwitchHref('/@jane/-/credits', acmeGuest)).toBe(
		'/@acme/-/credits',
	)
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
