import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountConnectionsRoute } from '#client/routes/account-connections.tsx'
import {
	accountPackagesNavHref,
	accountRailGroups,
	accountRailOrgSlug,
	isAccountNavItemActive,
	isAccountRailPath,
	workspaceRailGroups,
} from '#client/routes/account-rail.ts'
import { type SessionInfo } from '#client/session.ts'
import {
	accountConnectionAgentIds,
	accountConnectionsListHref,
	accountConnectionsNewHref,
	parseAccountConnectionsPathname,
} from '#universal/account-connections.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

function renderConnectionsPage(
	accountConnectedAgents: AccountConnectedAgentsLoaderData,
	url: string = routes.accountConnections.href(),
) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url,
			children: jsx(AppSessionProvider, {
				session,
				status: 'ready',
				children: jsx(AppLoaderDataProvider, {
					loaderData: { accountConnectedAgents },
					children: jsx(AccountConnectionsRoute, {}),
				}),
			}),
		}),
	)
}

const connectedCursor: AccountConnectedAgentsLoaderData = {
	ok: true,
	mcpServerUrl: 'https://kody.example/mcp',
	agents: [
		{
			clientId: 'cursor-client',
			grantIds: ['grant-1'],
			connectionProfileName: null,
			label: 'Cursor',
			kind: 'cursor',
			connectedAt: '2026-01-01T00:00:00.000Z',
			lastUsedAt: null,
		},
	],
}

test('connections page renders the connected list with Add connection, the MCP URL card, and the rail from SSR data', async () => {
	const html = await renderConnectionsPage(connectedCursor)

	expect(html).toContain('>Connections</h1>')
	// The connected list is the panel Overview used to host, plus the entry
	// point to the client wall.
	expect(html).toContain('aria-label="Connected agents"')
	expect(html).toContain('data-agent-label="Cursor"')
	expect(html).toContain('aria-label="Revoke Cursor"')
	expect(html).toContain('data-testid="connected-agent-view-steps"')
	expect(html).toContain('href="/account/connections/new/cursor"')
	expect(html).toMatch(/Last used <span[^>]*>unknown<\/span>/)
	expect(html).toMatch(
		/data-testid="account-connections-add"[^>]*>Add connection</,
	)
	expect(html).toContain(`href="${routes.accountConnectionNew.href()}"`)
	expect(html).toContain('aria-label="MCP URL"')
	expect(html).toContain('>https://kody.example/mcp<')
	expect(html).toContain('Copy MCP URL')
	expect(html).not.toContain('data-testid="account-connections-verify-note"')
	expect(html).not.toContain('data-testid="account-connections-agent-grid"')
	expect(html).not.toContain('data-testid="account-connections-back"')
	expect(html).toContain('href="/docs/connect-your-agent"')
	expect(html).toContain(`href="${routes.accountMcpOauthClients.href()}"`)
	// No cold-path loading copy when the SSR payload is present.
	expect(html).not.toContain('Loading connections')
	// The workspace rail marks this page current and links Repositories to
	// the workspace list, not the public profile.
	expect(html).toContain('aria-label="Workspace sections"')
	expect(html).toMatch(/href="\/@jane\/connections"[^>]*aria-current="page"/)
	expect(html).toMatch(
		/href="\/@jane\/packages"[^>]*>[\s\S]*?Repositories<\/a>/,
	)
	expect(html).toContain('data-icon="box"')
})

test('Add connection shows every named client on every viewport; already-connected hosts stay links with a Connected mark', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		routes.accountConnectionNew.href(),
	)

	expect(html).toContain('data-testid="account-connections-agent-grid"')
	expect(html).toContain('aria-label="Add connection"')
	expect(html).toMatch(
		/data-testid="account-connections-back"[^>]*>← back to connections</,
	)
	expect(html).toContain(`href="${routes.accountConnections.href()}"`)
	// The list is its own page; it does not wrap the grid.
	expect(html).not.toContain('aria-label="Connected agents"')
	expect(html).not.toContain('data-testid="account-connections-add"')
	// Every named client is a card, in catalog order; `other` is not a card
	// because the generic MCP URL path sits under the grid instead.
	for (const id of accountConnectionAgentIds) {
		expect(html).toMatch(
			new RegExp(
				`href="/account/connections/new/${id}"[^>]*data-testid="onboarding-agent-${id}"`,
			),
		)
	}
	// Already-connected Cursor keeps a Connected mark and remains a link.
	expect(html).toMatch(
		/href="\/account\/connections\/new\/cursor"[^>]*data-greyed="true"/,
	)
	expect(html).toContain('data-greyed-reason="connected"')
	expect(html).toContain(
		'Already connected. Select to view connect steps again.',
	)
	// No card is hidden behind the onboarding phone/desktop media query: every
	// card `<li>` shares one class whose rules never reach `display: none`.
	const cards = [
		...html.matchAll(
			/<li class="(rmxc-[^"]+)"><a href="\/account\/connections\/new\//g,
		),
	]
	expect(cards).toHaveLength(accountConnectionAgentIds.length)
	const cardClasses = new Set(cards.map((card) => card[1]))
	expect(cardClasses.size).toBe(1)
	const [cardClass] = cardClasses
	const rulesStart = html.indexOf(`@layer rmx.${cardClass}`)
	expect(rulesStart).toBeGreaterThan(-1)
	const rules = html.slice(rulesStart, html.indexOf('</style>', rulesStart))
	expect(rules).toContain('display: list-item')
	expect(rules).not.toContain('display: none')
	// The generic MCP URL path stays available under the grid.
	expect(html).toContain('Using something else?')
	expect(html).toContain('>https://kody.example/mcp<')
	// The standalone MCP URL panel is not repeated on this view.
	expect(html).not.toContain('aria-label="MCP URL"')
})

test('picking a client shows that host’s install steps with a way back to the grid', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		routes.accountConnectionNewAgent.href({ agent: 'claude-code' }),
	)

	expect(html).toContain('aria-label="Connect Claude Code"')
	expect(html).toContain('>Connect Claude Code</h2>')
	expect(html).toMatch(
		/data-testid="account-connections-agent-instructions"[^>]*data-agent="claude-code"/,
	)
	expect(html).toContain('claude mcp add --transport http -s user kody')
	expect(html).toContain('data-testid="onboarding-authenticate-callout"')
	expect(html).toMatch(
		new RegExp(
			`href="${routes.accountConnectionNew.href()}"[^>]*data-testid="account-connections-change-agent"`,
		),
	)
	expect(html).not.toContain('data-testid="account-connections-agent-grid"')
	expect(html).toMatch(
		/data-testid="account-connections-back"[^>]*>← back to connections</,
	)
	expect(html).not.toContain('aria-label="Connected agents"')
	// Connections stays the current rail item on the add views.
	expect(html).toMatch(/href="\/@jane\/connections"[^>]*aria-current="page"/)
})

test('an unknown agent segment renders the fallback instead of instructions', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		'/account/connections/new/not-a-client',
	)
	expect(html).toContain('>Unknown agent</h2>')
	expect(html).toContain('data-testid="account-connections-back"')
	expect(html).not.toContain('aria-label="Connected agents"')
	expect(html).not.toContain(
		'data-testid="account-connections-agent-instructions"',
	)
})

test('connections views parse from the pathname', () => {
	const cases = [
		['/account/connections', { kind: 'list' }],
		['/account/connections/new', { kind: 'new', agent: null }],
		['/account/connections/new/cursor', { kind: 'new', agent: 'cursor' }],
		['/account/connections/new/other', null],
		['/account/connections/new/nope', null],
		['/account/connections/new/cursor/x', null],
		['/account/connections/nope', null],
		['/@jane/connections', { kind: 'list' }],
		['/@jane/connections/new', { kind: 'new', agent: null }],
		['/@jane/connections/new/cursor', { kind: 'new', agent: 'cursor' }],
		['/@jane/connections/new/nope', null],
	] as const
	expect(
		cases.map(([pathname]) => [
			pathname,
			parseAccountConnectionsPathname(pathname),
		]),
	).toEqual(cases)
	expect(accountConnectionsNewHref(null)).toBe('/account/connections/new')
	expect(accountConnectionsNewHref('grok-cli')).toBe(
		'/account/connections/new/grok-cli',
	)
	expect(accountConnectionsListHref('/@jane/connections')).toBe(
		'/@jane/connections',
	)
	expect(accountConnectionsNewHref(null, '/@jane/connections')).toBe(
		'/@jane/connections/new',
	)
	expect(accountConnectionsNewHref('cursor', '/@jane/connections')).toBe(
		'/@jane/connections/new/cursor',
	)
})

test('connections list under /@slug keeps Add and View steps on org paths', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		'/@jane/connections',
	)
	expect(html).toContain('href="/@jane/connections/new"')
	expect(html).toContain('href="/@jane/connections/new/cursor"')
	expect(html).not.toContain('href="/account/connections/new"')
	expect(html).not.toContain('href="/account/connections/new/cursor"')
})

test('connections page swaps the copy card for a verify note while the email is unverified', async () => {
	const html = await renderConnectionsPage({
		ok: true,
		mcpServerUrl: '',
		agents: [],
	})

	expect(html).toContain('data-testid="account-connections-verify-note"')
	expect(html).toContain(`href="${routes.pendingVerification.href()}"`)
	expect(html).not.toContain('Copy MCP URL')
	expect(html).toContain('No agents have authorized yet.')
})

test('connection profiles list only granted packages and add more through a package combobox', async () => {
	const packageOptions = Array.from({ length: 40 }, (_, index) => ({
		id: `pkg-${index}`,
		name: `tool-${index}`,
		kodyId: `@jane/tool-${String(index).padStart(2, '0')}`,
	}))
	const html = await renderConnectionsPage({
		...connectedCursor,
		connectionProfilesEnabled: true,
		connectionProfilePackageOptions: packageOptions,
		connectionProfiles: [
			{
				id: 'profile-ci',
				name: 'ci',
				grants: [
					{ resourceType: 'package', resourceId: 'pkg-3', actions: ['read'] },
					{
						resourceType: 'package',
						resourceId: 'pkg-gone',
						actions: ['execute', 'read'],
					},
				],
				mcpServerUrl: 'https://kody.example/mcp?profile=ci',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
		],
	})

	expect(html).toContain('data-testid="connection-profiles"')
	expect(html).toContain('>https://kody.example/mcp?profile=ci<')
	const profileCard = html.slice(
		html.indexOf('data-testid="connection-profile-profile-ci"'),
		html.indexOf('data-testid="connection-profile-create"'),
	)
	// The profile card lists only its grants (a deleted package stays visible
	// so it can still be removed), not one row per account package.
	expect(profileCard).toContain('aria-label="Packages granted to ci"')
	expect(profileCard).toContain('>@jane/tool-03<')
	expect(profileCard).toContain('>read<')
	expect(profileCard).toContain('>read · execute<')
	expect(profileCard).toContain('>Unknown package<code>pkg-gone</code>')
	expect(profileCard).not.toContain('@jane/tool-04')
	expect(profileCard).toContain('aria-label="Edit packages for ci"')

	const createForm = html.slice(
		html.indexOf('data-testid="connection-profile-create"'),
	)
	// A new profile starts with no packages; every saved package is
	// reachable through the combobox instead of a grant-scoped list.
	expect(createForm).toContain('No packages yet')
	expect(createForm).toMatch(
		/<label[^>]*for="connection-profile-create-add-package"[^>]*>Add package</,
	)
	expect(createForm).toContain('placeholder="Search saved packages"')
	expect(createForm.match(/role="option"/g)).toHaveLength(40)
	expect(createForm).not.toContain('pkg-3"')
})

test('account rail holds only the person: profile, security, organizations, experiments, data', () => {
	const items = accountRailGroups().flatMap((group) => group.items)
	expect(items.map((item) => [item.label, item.href])).toEqual([
		['Profile', '/account'],
		['Security', '/account/security'],
		['Organizations', '/account/organizations'],
		['Experiments', '/account/experiments'],
		['Data & deletion', '/account/data'],
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
		'/@jane/secrets',
		'/@jane/packages',
	]) {
		expect(isAccountRailPath(path), path).toBe(false)
	}
})

test('workspace rail groups what the organization owns and keeps its slug in every link', () => {
	const groups = workspaceRailGroups({
		orgSlug: 'jane',
		personal: true,
		showShared: true,
	})
	expect(
		groups.map((group) => [group.label, group.items.map((item) => item.label)]),
	).toEqual([
		['Build', ['Repositories', 'Jobs', 'Workflows', 'Webhooks']],
		['Access', ['Connections', 'Integrations', 'MCP servers', 'Shared']],
		['Data', ['Secrets', 'Secret providers', 'Memories', 'Email']],
		['Activity', ['Activity', 'Waiting']],
		['Organization', ['Billing', 'Usage']],
	])
	const items = groups.flatMap((group) => group.items)
	// Repositories is the workspace list, not the public profile.
	expect(items.find((item) => item.label === 'Repositories')?.href).toBe(
		'/@jane/packages',
	)
	expect(items.find((item) => item.label === 'Secret providers')?.href).toBe(
		'/@jane/secret-providers',
	)
	const usage = items.find((item) => item.label === 'Usage')
	expect(usage && isAccountNavItemActive(usage, '/account/credits')).toBe(true)
	const connections = items.find((item) => item.label === 'Connections')
	expect(
		connections &&
			isAccountNavItemActive(connections, '/account/mcp-oauth-clients'),
	).toBe(true)
	expect(
		connections &&
			isAccountNavItemActive(connections, '/@jane/connections/new'),
	).toBe(true)
	expect(accountPackagesNavHref(null)).toBe('/account/packages')

	const withoutShared = workspaceRailGroups({
		orgSlug: 'jane',
		personal: true,
		showShared: false,
	}).flatMap((group) => group.items)
	expect(withoutShared.map((item) => item.label)).not.toContain('Shared')
})

test('workspace rail is empty for a team organization until its storage lands (#3073)', () => {
	expect(
		workspaceRailGroups({ orgSlug: 'acme', personal: false, showShared: true }),
	).toEqual([])
})

test('account rail org slug prefers the path org over username', () => {
	const organizations = [
		{ slug: 'ada-old', personal: true },
		{ slug: 'acme', personal: false },
	]
	expect(
		accountRailOrgSlug({
			pathname: '/@acme/jobs',
			organizations,
			username: 'ada-new',
		}),
	).toBe('acme')
	expect(
		accountRailOrgSlug({
			pathname: '/account',
			organizations,
			username: 'ada-new',
		}),
	).toBe('ada-old')
})
