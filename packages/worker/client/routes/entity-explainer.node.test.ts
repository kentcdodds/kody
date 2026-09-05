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
	expect(
		resolveEntityExplainer(routes.profile.href({ username: 'jane' })),
	).toBeNull()
	expect(
		resolveEntityExplainer(
			routes.communityPackage.href({ username: 'jane', kodyId: 'helper' }),
		),
	).toBeNull()

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

	const comparisonHref = routes.guideDetail.href({
		slug: 'packages-integrations-mcp',
	})
	const copy = resolveEntityExplainer(routes.accountPackages.href())
	expect(copy).not.toBeNull()
	if (!copy) throw new Error('expected packages explainer')
	expect(copy.paragraphs.join(' ')).toContain(
		'open a package to change visibility, publish lock, or delete it',
	)
	expect(copy.learnMore?.map((link) => link.href)).toEqual([
		comparisonHref,
		routes.guideDetail.href({ slug: 'package-lifecycle' }),
	])

	const integrationsCopy = resolveEntityExplainer(
		routes.accountIntegrations.href(),
	)
	expect(integrationsCopy?.id).toBe('integrations')
	expect(integrationsCopy?.learnMore?.map((link) => link.href)).toEqual([
		comparisonHref,
		routes.guideDetail.href({ slug: 'integration-bootstrap' }),
	])

	const mcpCopy = resolveEntityExplainer(routes.accountMcpServers.href())
	expect(mcpCopy?.id).toBe('mcp-servers')
	expect(mcpCopy?.learnMore?.map((link) => link.href)).toEqual([comparisonHref])

	const explainerHtml = await renderToString(jsx(EntityExplainer, { copy }))
	expect(explainerHtml).toContain('data-entity-explainer="packages"')
	expect(explainerHtml).toContain(`href="${comparisonHref}"`)
	expect(explainerHtml).toContain(
		`href="${routes.guideDetail.href({ slug: 'package-lifecycle' })}"`,
	)
	expect(explainerHtml).toMatch(
		/<details(?![^>]*\bopen\b)[^>]*data-entity-explainer="packages"/,
	)

	const integrationsHtml = await renderToString(
		jsx(EntityExplainer, { copy: integrationsCopy! }),
	)
	expect(integrationsHtml).toContain(`href="${comparisonHref}"`)
	const mcpHtml = await renderToString(jsx(EntityExplainer, { copy: mcpCopy! }))
	expect(mcpHtml).toContain(`href="${comparisonHref}"`)

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
