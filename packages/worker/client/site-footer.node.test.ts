import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { SiteFooter } from '#client/site-footer.tsx'

test('site footer nav uses a two-row five-column grid, then stacked auto-fit', async () => {
	const html = await renderToString(
		jsx(SiteFooter, { loggedIn: true, loginHref: '/login' }),
	)

	expect(html).toContain('aria-label="Footer"')
	expect(html).toContain('href="/account"')
	expect(html).toContain('repeat(5, max-content)')
	expect(html).toContain(
		'repeat(auto-fit, minmax(min(100%, 7.5rem), max-content))',
	)
	expect(html).toContain('@media (max-width: 900px)')

	const loggedOut = await renderToString(
		jsx(SiteFooter, { loggedIn: false, loginHref: '/login?next=%2Fsupport' }),
	)
	expect(loggedOut).toContain('href="/login?next=%2Fsupport"')
	expect(loggedOut).not.toContain('href="/account"')
})
