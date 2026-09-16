import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderSecretProvidersFlagCallout } from '#client/routes/secret-providers-flag-callout.tsx'
import { secretProvidersFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'

test('secret providers flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderSecretProvidersFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="secret-providers-flag-callout"')
	expect(loggedOut).toContain(`data-flag="${secretProvidersFlagKey}"`)
	expect(loggedOut).toContain(
		'Custom secret providers are behind a feature flag because they may change or go away.',
	)
	expect(loggedOut).toContain('data-testid="secret-providers-flag-login"')
	expect(loggedOut).toContain('Log in to try it')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'secret-providers' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="secret-providers-flag-opt-in"')

	const loggedIn = await renderToString(
		renderSecretProvidersFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="secret-providers-flag-opt-in"')
	expect(loggedIn).toContain('Try secret providers')
	expect(loggedIn).toContain(
		`action="${routes.secretProvidersOptInPost.href()}"`,
	)
	expect(loggedIn).toContain('method="post"')
	expect(loggedIn).not.toContain('data-testid="secret-providers-flag-login"')

	const alreadyOn = await renderToString(
		renderSecretProvidersFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).toContain('You are trying custom secret providers.')
	expect(alreadyOn).not.toContain('data-testid="secret-providers-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="secret-providers-flag-login"')
})
