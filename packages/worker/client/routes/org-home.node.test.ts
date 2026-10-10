import { expect, test } from 'vitest'
import { renderToString } from 'remix/component/server'
import { renderOrgHomeMain } from './org-home.tsx'

test('org home lists every management section for a member', async () => {
	const html = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: 'member',
		}),
	)
	expect(html).toContain('data-testid="org-home-nav"')
	expect(html).toContain('href="/@acme/-/settings"')
	expect(html).toContain('href="/@acme/-/members"')
	expect(html).toContain('href="/@acme/-/teams"')
	expect(html).toContain('href="/@acme/-/grants"')
	expect(html).toContain('href="/@acme/-/collaborators"')
	expect(html).not.toContain('href="/@acme/-/billing"')
	expect(html).toContain('href="/@acme/-/secrets"')
	expect(html).toContain('href="/@acme/-/jobs"')
})

test('org home includes billing for owners and hides teams for billing admins', async () => {
	const owner = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: 'owner',
		}),
	)
	expect(owner).toContain('href="/@acme/-/billing"')
	expect(owner).toContain('href="/@acme/-/teams"')

	const billing = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: 'billing',
		}),
	)
	expect(billing).toContain('href="/@acme/-/billing"')
	expect(billing).not.toContain('href="/@acme/-/teams"')
	expect(billing).toContain('href="/@acme/-/settings"')
})

test('org home hides management nav for collaborators', async () => {
	const html = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: null,
		}),
	)
	expect(html).not.toContain('data-testid="org-home-nav"')
	expect(html).toContain('Connect an agent')
})
