import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderDocsPager, renderDocsShell } from '#client/routes/docs-shell.tsx'
import { docsIntroSlug } from '#universal/docs-nav.ts'

test('docs shell marks the sidebar and highlights the open page', async () => {
	const html = await renderToString(
		renderDocsShell({
			current: 'oauth',
			children: jsx('p', { children: 'Article' }),
		}),
	)

	expect(html).toContain('data-docs-shell')
	expect(html).toContain('data-docs-nav')
	expect(html).toContain('href="/docs/oauth"')
	expect(html).toContain('aria-current="page"')
	expect(html).toContain('data-section-current="true"')
	expect(html).not.toContain('href="/docs/what-is-kody"')
	expect(html).toContain('href="/docs"')
	expect(html).toContain('href="/docs/search-and-execute"')
	expect(html.indexOf('href="/docs"')).toBeLessThan(
		html.indexOf('href="/docs/search-and-execute"'),
	)
	expect(html.indexOf('href="/docs/search-and-execute"')).toBeLessThan(
		html.indexOf('href="/docs/how-kody-works"'),
	)
})

test('docs shell treats /docs/connect as the providers section', async () => {
	const html = await renderToString(
		renderDocsShell({
			current: 'connect',
			children: jsx('p', { children: 'Providers' }),
		}),
	)

	expect(html).toContain('href="/docs/connect"')
	expect(html).toMatch(/<a[^>]*href="\/docs\/connect"[^>]*aria-current="page"/)
	expect(html).toContain('data-section-current="true"')
})

test('docs pager omits empty placeholders and links neighbors', async () => {
	const first = await renderToString(renderDocsPager(docsIntroSlug))
	expect(first).toContain('href="/docs/search-and-execute"')
	expect(first).not.toContain('<span></span>')
	expect(first).not.toContain('Previous')

	const last = await renderToString(renderDocsPager('platform-friction'))
	expect(last).toContain('Previous')
	expect(last).not.toContain('Next')
})
