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
) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url: routes.accountConnections.href(),
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

test('connections page renders the MCP URL copy card, the connected agents, and the setup guide paths from SSR data', async () => {
	const html = await renderConnectionsPage({
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
	})

	expect(html).toContain('>Connections</h1>')
	expect(html).toContain('aria-label="Connect an agent"')
	expect(html).toContain('>https://kody.example/mcp<')
	expect(html).toContain('Copy MCP URL')
	expect(html).not.toContain('data-testid="account-connections-verify-note"')
	expect(html).toMatch(/data-testid="account-connections-setup-guides"[^>]*/)
	expect(html).toContain(`href="${routes.onboarding.href()}"`)
	expect(html).toContain('href="/docs/connect-your-agent"')
	expect(html).toContain('aria-label="Connected agents"')
	expect(html).toContain('data-agent-label="Cursor"')
	expect(html).toContain('aria-label="Revoke Cursor"')
	expect(html).toContain(`href="${routes.accountMcpOauthClients.href()}"`)
	// No cold-path loading copy when the SSR payload is present.
	expect(html).not.toContain('Loading connections')
	// The rail marks this page current and links Packages to the profile.
	expect(html).toMatch(/href="\/account\/connections"[^>]*aria-current="page"/)
	expect(html).toMatch(/href="\/@jane"[^>]*>Packages<\/a>/)
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
