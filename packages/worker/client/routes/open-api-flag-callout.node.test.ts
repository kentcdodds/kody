import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderOpenApiFlagCallout } from '#client/routes/open-api-flag-callout.tsx'
import {
	localExecuteFlagKey,
	mcpApiToolFlagKey,
} from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'

test('open api flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderOpenApiFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="open-api-flag-callout"')
	expect(loggedOut).toContain(
		`data-flag="${mcpApiToolFlagKey},${localExecuteFlagKey}"`,
	)
	expect(loggedOut).toContain('data-testid="open-api-flag-login"')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'open-api' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="open-api-flag-opt-in"')

	const loggedIn = await renderToString(
		renderOpenApiFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="open-api-flag-opt-in"')
	expect(loggedIn).toContain(`action="${routes.openApiOptInPost.href()}"`)
	expect(loggedIn).toContain('method="post"')
	expect(loggedIn).not.toContain('data-testid="open-api-flag-login"')

	const alreadyOn = await renderToString(
		renderOpenApiFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).not.toContain('data-testid="open-api-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="open-api-flag-login"')
})
