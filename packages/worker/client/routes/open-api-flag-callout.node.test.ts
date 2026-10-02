import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { renderOpenApiFlagCallout } from '#client/routes/open-api-flag-callout.tsx'

test('open api flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderOpenApiFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="open-api-flag-callout"')
	expect(loggedOut).toContain('data-flag="mcp-api-tool,local-execute"')
	expect(loggedOut).toContain('data-testid="open-api-flag-login"')
	expect(loggedOut).toContain('href="/login?redirectTo=%2Fdocs%2Fopen-api"')
	expect(loggedOut).not.toContain('data-testid="open-api-flag-opt-in"')

	const loggedIn = await renderToString(
		renderOpenApiFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="open-api-flag-opt-in"')
	expect(loggedIn).toContain('action="/docs/open-api/opt-in"')
	expect(loggedIn).toContain('method="post"')
	expect(loggedIn).not.toContain('data-testid="open-api-flag-login"')

	const alreadyOn = await renderToString(
		renderOpenApiFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).not.toContain('data-testid="open-api-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="open-api-flag-login"')
})
