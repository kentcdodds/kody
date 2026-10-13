import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { InternalErrorPage } from '#client/internal-error-page.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'

test('internal-error page shows the zapped illustration and recovery destinations', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '/account',
			children: jsx(InternalErrorPage, {}),
		}),
	)

	expect(html).toContain('data-testid="internal-error-page"')
	expect(html).toContain('href="/account"')
	expect(html).toContain('href="/"')
	expect(html).toContain('data-error-agent-prompt')
})

test('internal-error Try again stays same-origin for protocol-relative URLs', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '//evil.example',
			children: jsx(InternalErrorPage, {}),
		}),
	)

	expect(html).not.toContain('href="//evil.example"')
	expect(html).toContain('href="/"')
})
