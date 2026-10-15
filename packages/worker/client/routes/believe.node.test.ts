import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { docHref, listDocsNavSlugs } from '#universal/docs-nav.ts'
import { BelieveRoute } from './believe.tsx'

test('believe page ties each belief to a published doc', async () => {
	const html = await renderToString(jsx(BelieveRoute, {}))

	expect(html).toContain('<h1>What we believe</h1>')
	expect(html.match(/<h2 /g)).toHaveLength(5)
	expect(html.match(/In the product: /g)).toHaveLength(5)
	expect(html).toContain('The best software is invisible.')
	expect(html).not.toContain('\u2014')
	expect(html).toContain('href="/"')

	const docLinks = [...html.matchAll(/href="(\/docs[^"]*)"/g)].map(
		(match) => match[1],
	)
	expect(docLinks).toHaveLength(5)
	const publishedDocHrefs = listDocsNavSlugs({ includeAdmin: false }).map(
		docHref,
	)
	for (const href of docLinks) {
		expect(publishedDocHrefs).toContain(href)
	}
})
