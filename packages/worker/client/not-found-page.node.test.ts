import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	NotFoundPage,
	notFoundPageHeading,
	notFoundPageImageSrc,
} from '#client/not-found-page.tsx'

test('not-found page shows the disappointed illustration and recovery destinations', async () => {
	const html = await renderToString(jsx(NotFoundPage, {}))

	expect(html).toContain('data-testid="not-found-page"')
	expect(html).toContain(notFoundPageHeading)
	expect(html).toContain(`src="${notFoundPageImageSrc}"`)
	expect(html).toContain('href="/"')
	expect(html).toContain('href="/docs"')
	expect(html).toContain('href="/community"')
})
