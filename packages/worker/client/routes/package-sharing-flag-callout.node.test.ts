import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderPackageSharingFlagCallout } from '#client/routes/package-sharing-flag-callout.tsx'
import { packageShareGrantsFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'

test('package sharing flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderPackageSharingFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="package-sharing-flag-callout"')
	expect(loggedOut).toContain(`data-flag="${packageShareGrantsFlagKey}"`)
	expect(loggedOut).toContain(
		'Package sharing is behind a feature flag because it may change or go away.',
	)
	expect(loggedOut).toContain('data-testid="package-sharing-flag-login"')
	expect(loggedOut).toContain('Log in to try it')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'package-sharing' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="package-sharing-flag-opt-in"')

	const loggedIn = await renderToString(
		renderPackageSharingFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="package-sharing-flag-opt-in"')
	expect(loggedIn).toContain('Try sharing')
	expect(loggedIn).toContain(
		`action="${routes.packageSharingOptInPost.href()}"`,
	)
	expect(loggedIn).toContain('method="post"')
	expect(loggedIn).not.toContain('data-testid="package-sharing-flag-login"')

	const alreadyOn = await renderToString(
		renderPackageSharingFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).toContain('You are trying package sharing.')
	expect(alreadyOn).not.toContain('data-testid="package-sharing-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="package-sharing-flag-login"')
})
