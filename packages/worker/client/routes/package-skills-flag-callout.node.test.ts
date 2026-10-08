import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { renderPackageSkillsFlagCallout } from '#client/routes/package-skills-flag-callout.tsx'
import { mcpSkillsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'

test('package skills flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderPackageSkillsFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="package-skills-flag-callout"')
	expect(loggedOut).toContain(`data-flag="${mcpSkillsExtensionFlagKey}"`)
	expect(loggedOut).toContain('data-testid="package-skills-flag-login"')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'package-skills' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="package-skills-flag-opt-in"')

	const loggedIn = await renderToString(
		renderPackageSkillsFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="package-skills-flag-opt-in"')
	expect(loggedIn).toContain(`action="${routes.packageSkillsOptInPost.href()}"`)
	expect(loggedIn).toContain('method="post"')
	expect(loggedIn).not.toContain('data-testid="package-skills-flag-login"')

	const alreadyOn = await renderToString(
		renderPackageSkillsFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).not.toContain('data-testid="package-skills-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="package-skills-flag-login"')
})
