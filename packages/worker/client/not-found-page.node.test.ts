import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { NotFoundPage, notFoundPageHeading } from '#client/not-found-page.tsx'

test('not-found page shows the mismatch illustration, what happened, and next steps', async () => {
	const html = await renderToString(jsx(NotFoundPage, {}))

	expect(html).toContain('data-testid="not-found-page"')
	expect(html).toContain(notFoundPageHeading)
	expect(html).toContain('src="/images/kody-404-mismatch.jpg"')
	expect(html).toContain('href="/"')
	expect(html).toContain('href="/docs"')
	expect(html).toContain('href="/community"')
	expect(html).toContain('>Go home</a>')
	expect(html).toContain('>Search the docs</a>')
	expect(html).toContain('>Browse packages</a>')
	expect(html).toContain('unpublished')
})
