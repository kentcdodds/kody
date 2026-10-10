import { expect, test } from 'vitest'
import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { RouterLocationProvider } from '../router-location.tsx'
import { AccountBillingRoute } from './account-billing.tsx'

test('a retained billing route renders nothing when the URL has no billing slug', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '/account',
			children: jsx(AccountBillingRoute, {}),
		}),
	)
	expect(html).not.toContain('Not an organization billing URL')
	expect(html).not.toContain('Only owners and billing admins')
	expect(html.trim()).toBe('')
})
