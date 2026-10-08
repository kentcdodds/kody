import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { renderMcpEventsFlagCallout } from '#client/routes/mcp-events-flag-callout.tsx'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'

test('mcp events flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderMcpEventsFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="mcp-events-flag-callout"')
	expect(loggedOut).toContain(`data-flag="${mcpEventsExtensionFlagKey}"`)
	expect(loggedOut).toContain('data-testid="mcp-events-flag-login"')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'mcp-events' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="mcp-events-flag-opt-in"')

	const loggedIn = await renderToString(
		renderMcpEventsFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="mcp-events-flag-opt-in"')
	expect(loggedIn).toContain(routes.mcpEventsOptInPost.href())
	expect(loggedIn).not.toContain('data-testid="mcp-events-flag-login"')

	const alreadyOn = await renderToString(
		renderMcpEventsFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).toContain('You are trying MCP Events')
	expect(alreadyOn).not.toContain('data-testid="mcp-events-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="mcp-events-flag-login"')
})
