import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test, vi } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import {
	AccountConnectionsRoute,
	accountConnectionsRouteLoader,
} from '#client/routes/account-connections.tsx'
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
	url: string = '/account/agents',
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

	expect(html).toContain('>Agents</h1>')
	// The connected list is the panel Overview used to host, plus the entry
	// point to the client wall.
	expect(html).toContain('aria-label="Connected agents"')
	expect(html).toContain('data-agent-label="Cursor"')
	expect(html).toContain('aria-label="Revoke Cursor"')
	expect(html).toContain('data-testid="connected-agent-view-steps"')
	expect(html).toContain('href="/account/agents/new/cursor"')
	expect(html).toMatch(/Last used <span[^>]*>unknown<\/span>/)
	expect(html).toMatch(
		/data-testid="account-connections-add"[^>]*>Connect an agent</,
	)
	expect(html).toContain(`href="${'/account/agents/new'}"`)
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
	expect(html).toMatch(/href="\/@jane\/-\/agents"[^>]*aria-current="page"/)
	expect(html).toMatch(
		/href="\/@jane\/-\/repositories"[^>]*>[\s\S]*?Repositories<\/a>/,
	)
	expect(html).toContain('data-icon="box"')
})

test('Add connection shows every named client on every viewport; already-connected hosts stay links with a Connected mark', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		'/account/agents/new',
	)

	expect(html).toContain('data-testid="account-connections-agent-grid"')
	expect(html).toContain('aria-label="Connect an agent"')
	expect(html).toMatch(
		/data-testid="account-connections-back"[^>]*>← back to agents</,
	)
	expect(html).toContain(`href="${'/account/agents'}"`)
	// The list is its own page; it does not wrap the grid.
	expect(html).not.toContain('aria-label="Connected agents"')
	expect(html).not.toContain('data-testid="account-connections-add"')
	// Every named client is a card, in catalog order; `other` is not a card
	// because the generic MCP URL path sits under the grid instead.
	for (const id of accountConnectionAgentIds) {
		expect(html).toMatch(
			new RegExp(
				`href="/account/agents/new/${id}"[^>]*data-testid="onboarding-agent-${id}"`,
			),
		)
	}
	// Already-connected Cursor keeps a Connected mark and remains a link.
	expect(html).toMatch(
		/href="\/account\/agents\/new\/cursor"[^>]*data-greyed="true"/,
	)
	expect(html).toContain('data-greyed-reason="connected"')
	expect(html).toContain(
		'Already connected. Select to view connect steps again.',
	)
	// No card is hidden behind the onboarding phone/desktop media query: every
	// card `<li>` shares one class whose rules never reach `display: none`.
	const cards = [
		...html.matchAll(
			/<li class="(rmxc-[^"]+)"><a href="\/account\/agents\/new\//g,
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
		'/account/agents/new/claude-code',
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
			`href="${'/account/agents/new'}"[^>]*data-testid="account-connections-change-agent"`,
		),
	)
	expect(html).not.toContain('data-testid="account-connections-agent-grid"')
	expect(html).toMatch(
		/data-testid="account-connections-back"[^>]*>← back to agents</,
	)
	expect(html).not.toContain('aria-label="Connected agents"')
	// Connections stays the current rail item on the add views.
	expect(html).toMatch(/href="\/@jane\/-\/agents"[^>]*aria-current="page"/)
})

test('an unknown agent segment renders the fallback instead of instructions', async () => {
	const html = await renderConnectionsPage(
		connectedCursor,
		'/account/agents/new/not-a-client',
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
		['/account/agents', { kind: 'list' }],
		['/account/agents/new', { kind: 'new', agent: null }],
		['/account/agents/new/cursor', { kind: 'new', agent: 'cursor' }],
		['/account/agents/new/other', null],
		['/account/agents/new/nope', null],
		['/account/agents/new/cursor/x', null],
		['/account/agents/nope', null],
		['/@jane/-/agents', { kind: 'list' }],
		['/@jane/-/agents/new', { kind: 'new', agent: null }],
		['/@jane/-/agents/new/cursor', { kind: 'new', agent: 'cursor' }],
		['/@jane/-/agents/new/nope', null],
	] as const
	expect(
		cases.map(([pathname]) => [
			pathname,
			parseAccountConnectionsPathname(pathname),
		]),
	).toEqual(cases)
	expect(accountConnectionsNewHref(null)).toBe('/account/agents/new')
	expect(accountConnectionsNewHref('grok-cli')).toBe(
		'/account/agents/new/grok-cli',
	)
	expect(accountConnectionsListHref('/@jane/-/agents')).toBe('/@jane/-/agents')
	expect(accountConnectionsNewHref(null, '/@jane/-/agents')).toBe(
		'/@jane/-/agents/new',
	)
	expect(accountConnectionsNewHref('cursor', '/@jane/-/agents')).toBe(
		'/@jane/-/agents/new/cursor',
	)
})

test('connections list under /@slug keeps Add and View steps on org paths', async () => {
	const html = await renderConnectionsPage(connectedCursor, '/@jane/-/agents')
	expect(html).toContain('href="/@jane/-/agents/new"')
	expect(html).toContain('href="/@jane/-/agents/new/cursor"')
	expect(html).not.toContain('href="/account/agents/new"')
	expect(html).not.toContain('href="/account/agents/new/cursor"')
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

test('the connections loader names the destination org page as referrer', async () => {
	vi.stubGlobal('window', { location: { origin: 'https://kody.test' } })
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ ok: true, agents: [], mcpServerUrl: '' }), {
				headers: { 'Content-Type': 'application/json' },
			}),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		// A client navigation from another org: the loader runs before the URL
		// commits, so the Referer would otherwise name the source org.
		await accountConnectionsRouteLoader(
			new URL('https://kody.test/@acme/-/agents'),
			new AbortController().signal,
		)
		expect(fetchMock).toHaveBeenCalledWith(
			'/account/connected-agents.json',
			expect.objectContaining({
				referrer: 'https://kody.test/@acme/-/agents',
			}),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('the connections loader binds usage to the destination org, skips it on Add connection, and never waits long for it', async () => {
	vi.stubGlobal('window', { location: { origin: 'https://kody.test' } })
	const agentsPayload = { ok: true, agents: [], mcpServerUrl: '' }
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === '/account/connection-usage.json') {
				// Never answers until aborted, like a stalled usage request.
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('Aborted', 'AbortError')),
					)
				})
			}
			return new Response(JSON.stringify(agentsPayload), {
				headers: { 'Content-Type': 'application/json' },
			})
		},
	)
	vi.stubGlobal('fetch', fetchMock)
	vi.useFakeTimers()
	try {
		const listLoad = accountConnectionsRouteLoader(
			new URL('https://kody.test/@acme/-/agents'),
			new AbortController().signal,
		)
		await vi.advanceTimersByTimeAsync(1500)
		expect(await listLoad).toEqual({ accountConnectedAgents: agentsPayload })
		expect(fetchMock).toHaveBeenCalledWith(
			'/account/connection-usage.json',
			expect.objectContaining({
				referrer: 'https://kody.test/@acme/-/agents',
			}),
		)

		fetchMock.mockClear()
		await accountConnectionsRouteLoader(
			new URL('https://kody.test/@acme/-/agents/new'),
			new AbortController().signal,
		)
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
			'/account/connected-agents.json',
		])
	} finally {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	}
})
