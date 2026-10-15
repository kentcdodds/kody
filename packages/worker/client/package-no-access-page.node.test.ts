import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { PackageNoAccessPage } from '#client/package-no-access-page.tsx'

test('package no-access page names the package and offers a request-access copy', async () => {
	const html = await renderToString(
		jsx(PackageNoAccessPage, {
			username: 'kody',
			kodyId: 'mau-chart',
			packageName: '@kody/mau-chart',
			viewerUsername: 'tannerlinsley',
		}),
	)

	expect(html).toContain('data-testid="package-no-access-page"')
	expect(html).toContain("You don't have access")
	expect(html).toContain('@kody/mau-chart')
	expect(html).toContain('@tannerlinsley')
	expect(html).toContain('app:execute')
	expect(html).toContain('hosted app')
	expect(html).toContain('href="/docs/package-sharing"')
	expect(html).toContain('Copy access request')
	expect(html).toContain('data-error-agent-prompt')
})
