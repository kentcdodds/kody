import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountConnectionsRoute } from '#client/routes/account-connections.tsx'
import {
	accountNavItemsFor,
	accountPackagesNavHref,
} from '#client/routes/account-management-components.tsx'
import { type SessionInfo } from '#client/session.ts'
import {
	accountConnectionAgentIds,
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
			label: 'Cursor',
			kind: 'cursor',
			connectedAt: '2026-01-01T00:00:00.000Z',
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
	expect(html).toMatch(
		/data-testid="account-connections-add"[^>]*>Add connection</,
	)
	expect(html).toContain(`href="${routes.accountConnectionNew.href()}"`)
	expect(html).toContain('aria-label="MCP URL"')
	expect(html).toContain('>https://kody.example/mcp<')
	expect(html).toContain('Copy MCP URL')
	expect(html).not.toContain('data-testid="account-connections-verify-note"')
	expect(html).not.toContain('data-testid="account-connections-agent-grid"')
	expect(html).toContain('href="/docs/connect-your-agent"')
	expect(html).toContain(`href="${routes.accountMcpOauthClients.href()}"`)
	// No cold-path loading copy when the SSR payload is present.
	expect(html).not.toContain('Loading connections')
	// The rail marks this page current and links Packages to the profile.
	expect(html).toMatch(/href="\/account\/connections"[^>]*aria-current="page"/)
	expect(html).toMatch(/href="\/@jane"[^>]*>[\s\S]*?Packages<\/a>/)
	expect(html).toContain('data-icon="box"')
})

test('Add connection shows every named client on every viewport with none greyed or folded away', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		routes.accountConnectionNew.href(),
	)

	expect(html).toContain('data-testid="account-connections-agent-grid"')
	expect(html).toContain('aria-label="Add connection"')
	// The list stays on screen above the grid; its Add button steps aside.
	expect(html).toContain('aria-label="Connected agents"')
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
	expect(accountConnectionAgentIds).toHaveLength(14)
	expect(accountConnectionAgentIds).not.toContain('other')
	expect(html).not.toContain('data-testid="onboarding-agent-other"')
	expect(html).not.toContain('data-greyed="true"')
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
	// Connections stays the current rail item on the nested view.
	expect(html).toMatch(/href="\/account\/connections"[^>]*aria-current="page"/)
})

test('an unknown agent segment renders the fallback instead of instructions', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		'/account/connections/new/not-a-client',
	)
	expect(html).toContain('>Unknown agent</h2>')
	expect(html).not.toContain(
		'data-testid="account-connections-agent-instructions"',
	)
})

test('connections views parse from the pathname', () => {
	expect(parseAccountConnectionsPathname('/account/connections')).toEqual({
		kind: 'list',
	})
	expect(parseAccountConnectionsPathname('/account/connections/new')).toEqual({
		kind: 'new',
		agent: null,
	})
	expect(
		parseAccountConnectionsPathname('/account/connections/new/cursor'),
	).toEqual({ kind: 'new', agent: 'cursor' })
	expect(
		parseAccountConnectionsPathname('/account/connections/new/other'),
	).toBeNull()
	expect(
		parseAccountConnectionsPathname('/account/connections/new/nope'),
	).toBeNull()
	expect(
		parseAccountConnectionsPathname('/account/connections/new/cursor/x'),
	).toBeNull()
	expect(
		parseAccountConnectionsPathname('/account/connections/nope'),
	).toBeNull()
	expect(accountConnectionsNewHref(null)).toBe('/account/connections/new')
	expect(accountConnectionsNewHref('grok-cli')).toBe(
		'/account/connections/new/grok-cli',
	)
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

test('account rail lists Connections and Packages at the same level as the other sections', () => {
	const labels = accountNavItemsFor({
		username: 'jane',
		showShared: false,
	}).map((item) => item.label)
	expect(labels).toEqual([
		'Overview',
		'Waiting',
		'Connections',
		'Packages',
		'Billing',
		'Usage',
		'Activity',
		'Jobs',
		'Workflows',
		'Webhooks',
		'Secrets',
		'Integrations',
		'MCP servers',
		'Memories',
		'Email',
	])

	const withShared = accountNavItemsFor({ username: 'jane', showShared: true })
	expect(withShared.map((item) => item.label)).toContain('Shared')
	expect(withShared.find((item) => item.label === 'Connections')?.href).toBe(
		'/account/connections',
	)
	// Packages is the profile page — the canonical package list — not the
	// `/account/packages` redirect, unless the session has no username yet.
	expect(withShared.find((item) => item.label === 'Packages')?.href).toBe(
		'/@jane',
	)
	expect(accountPackagesNavHref(null)).toBe('/account/packages')
})

test('account rail items carry Iconic glyph names', () => {
	const items = accountNavItemsFor({ username: 'jane', showShared: true })
	expect(items.map((item) => [item.label, item.icon])).toEqual([
		['Overview', 'home'],
		['Waiting', 'clock'],
		['Connections', 'link'],
		['Packages', 'box'],
		['Shared', 'share'],
		['Billing', 'wallet'],
		['Usage', 'chart'],
		['Activity', 'trending-up'],
		['Jobs', 'briefcase'],
		['Workflows', 'refresh'],
		['Webhooks', 'cloud'],
		['Secrets', 'key'],
		['Integrations', 'plug'],
		['MCP servers', 'server'],
		['Memories', 'book'],
		['Email', 'mail'],
	])
})
