import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AccountPageHeader } from '#client/routes/account-management-components.tsx'
import {
	EntityExplainer,
	resolveEntityExplainer,
} from '#client/routes/entity-explainer.tsx'
import { routes } from '#universal/routes.ts'

test('resolves an explainer for entity pages and skips settings-only routes', () => {
	expect(resolveEntityExplainer(routes.accountPackages.href())?.question).toBe(
		'What is a package?',
	)
	expect(
		resolveEntityExplainer(
			routes.accountPackageDetail.href({ packageId: 'pkg_123' }),
		)?.paragraphs.join(' '),
	).toContain('bearer token')
	expect(
		resolveEntityExplainer(
			routes.accountPackageDetail.href({ packageId: 'pkg_123' }),
		)?.id,
	).toBe('packages')
	expect(resolveEntityExplainer(routes.accountEmail.href())?.question).toBe(
		'What is email?',
	)
	expect(resolveEntityExplainer(routes.accountJobs.href())?.question).toBe(
		'What is a job?',
	)
	expect(resolveEntityExplainer(routes.accountSecrets.href())?.question).toBe(
		'What is a secret?',
	)
	expect(
		resolveEntityExplainer(routes.accountIntegrations.href())?.question,
	).toBe('What is an integration?')
	expect(
		resolveEntityExplainer(routes.accountMcpServers.href())?.question,
	).toBe('What is an MCP server?')
	expect(resolveEntityExplainer(routes.accountMemories.href())?.question).toBe(
		'What is a memory?',
	)
	expect(resolveEntityExplainer(routes.accountActivity.href())?.question).toBe(
		'What is activity?',
	)
	expect(resolveEntityExplainer(routes.accountStars.href())?.question).toBe(
		'What is a star?',
	)
	expect(resolveEntityExplainer(routes.accountValues.href())?.question).toBe(
		'What is a value?',
	)
	expect(resolveEntityExplainer(routes.accountUsage.href())?.question).toBe(
		'What is usage?',
	)
	expect(resolveEntityExplainer(routes.community.href())?.question).toBe(
		'What is community?',
	)
	expect(resolveEntityExplainer(routes.timeline.href())?.question).toBe(
		'What is the timeline?',
	)

	expect(resolveEntityExplainer(routes.account.href())).toBeNull()
	expect(resolveEntityExplainer(routes.accountBilling.href())).toBeNull()
	expect(resolveEntityExplainer(routes.accountPasskeys.href())).toBeNull()
	expect(resolveEntityExplainer(routes.accountTwoFactor.href())).toBeNull()
	expect(resolveEntityExplainer(routes.login.href())).toBeNull()
	expect(resolveEntityExplainer(routes.pricing.href())).toBeNull()
	expect(resolveEntityExplainer(routes.admin.href())).toBeNull()
	expect(
		resolveEntityExplainer(
			routes.communityDetail.href({ listingId: 'listing_1' }),
		),
	).toBeNull()
})

test('entity explainer renders a collapsed details with a learn-more link', async () => {
	const copy = resolveEntityExplainer(routes.accountPackages.href())
	expect(copy).not.toBeNull()
	if (!copy) throw new Error('expected packages explainer')

	const html = await renderToString(jsx(EntityExplainer, { copy }))

	expect(html).toContain('data-entity-explainer="packages"')
	expect(html).toContain('<summary>What is a package?</summary>')
	expect(html).toContain(`href="${copy.learnMore?.href}"`)
	expect(html).toContain('Package lifecycle guide')
	expect(html).toMatch(
		/<details(?![^>]*\bopen\b)[^>]*data-entity-explainer="packages"/,
	)
})

test('account page header inserts the matching explainer under the title', async () => {
	const packagesHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Packages',
			description: 'Saved packages',
			currentHref: routes.accountPackages.href(),
		}),
	)
	expect(packagesHtml).toContain('data-entity-explainer="packages"')
	expect(packagesHtml).toContain('What is a package?')

	const overviewHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Overview',
			description: 'Account home',
			currentHref: routes.account.href(),
		}),
	)
	expect(overviewHtml).not.toContain('data-entity-explainer')
	expect(overviewHtml).not.toContain('What is a package?')
})
