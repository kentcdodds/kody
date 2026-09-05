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
	expect(resolveEntityExplainer(routes.accountEmail.href())?.id).toBe('email')
	expect(resolveEntityExplainer(routes.community.href())?.id).toBe('community')

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
	const integrationsCopy = resolveEntityExplainer(
		routes.accountIntegrations.href(),
	)
	expect(integrationsCopy?.id).toBe('integrations')

	const mcpCopy = resolveEntityExplainer(routes.accountMcpServers.href())
	expect(mcpCopy?.id).toBe('mcp-servers')

	const explainerHtml = await renderToString(
		jsx(EntityExplainer, { copy: integrationsCopy! }),
	)
	expect(explainerHtml).toContain('data-entity-explainer="integrations"')
	expect(explainerHtml).toContain(`href="${comparisonHref}"`)
	expect(explainerHtml).toMatch(
		/<details(?![^>]*\bopen\b)[^>]*data-entity-explainer="integrations"/,
	)

	const integrationsHtml = await renderToString(
		jsx(EntityExplainer, { copy: integrationsCopy! }),
	)
	expect(integrationsHtml).toContain(`href="${comparisonHref}"`)
	const mcpHtml = await renderToString(jsx(EntityExplainer, { copy: mcpCopy! }))
	expect(mcpHtml).toContain(`href="${comparisonHref}"`)

	const overviewHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Overview',
			description: 'Account home',
			currentHref: routes.account.href(),
		}),
	)
	expect(overviewHtml).not.toContain('data-entity-explainer')
})
