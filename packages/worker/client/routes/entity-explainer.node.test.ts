import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AccountPageHeader } from '#client/routes/account-management-components.tsx'
import {
	EntityExplainer,
	resolveEntityExplainer,
} from '#client/routes/entity-explainer.tsx'
import { routes } from '#universal/routes.ts'

test('entity explainers resolve on entity pages, render collapsed, and skip settings-only routes', async () => {
	expect(resolveEntityExplainer(routes.accountPackages.href())?.id).toBe(
		'packages',
	)
	expect(
		resolveEntityExplainer(
			routes.accountPackageDetail.href({ packageId: 'pkg_123' }),
		)?.id,
	).toBe('packages')
	expect(resolveEntityExplainer(routes.accountEmail.href())?.id).toBe('email')
	expect(resolveEntityExplainer(routes.community.href())?.id).toBe('community')
	expect(resolveEntityExplainer(routes.timeline.href())?.id).toBe('timeline')

	expect(resolveEntityExplainer(routes.account.href())).toBeNull()
	expect(resolveEntityExplainer(routes.accountBilling.href())).toBeNull()
	expect(resolveEntityExplainer(routes.accountPasskeys.href())).toBeNull()
	expect(resolveEntityExplainer(routes.login.href())).toBeNull()
	expect(resolveEntityExplainer(routes.admin.href())).toBeNull()
	expect(
		resolveEntityExplainer(
			routes.communityDetail.href({ listingId: 'listing_1' }),
		),
	).toBeNull()

	const copy = resolveEntityExplainer(routes.accountPackages.href())
	expect(copy).not.toBeNull()
	if (!copy) throw new Error('expected packages explainer')
	expect(copy.learnMore?.href).toBe(
		routes.guideDetail.href({ slug: 'package-lifecycle' }),
	)

	const explainerHtml = await renderToString(jsx(EntityExplainer, { copy }))
	expect(explainerHtml).toContain('data-entity-explainer="packages"')
	expect(explainerHtml).toContain(`href="${copy.learnMore?.href}"`)
	expect(explainerHtml).toMatch(
		/<details(?![^>]*\bopen\b)[^>]*data-entity-explainer="packages"/,
	)

	const packagesHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Packages',
			description: 'Saved packages',
			currentHref: routes.accountPackages.href(),
		}),
	)
	expect(packagesHtml).toContain('data-entity-explainer="packages"')

	const overviewHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Overview',
			description: 'Account home',
			currentHref: routes.account.href(),
		}),
	)
	expect(overviewHtml).not.toContain('data-entity-explainer')
})
