import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	MarkdownView,
	getSafeMarkdownLinkHref,
} from '#client/markdown-view.tsx'

async function renderMarkdown(markdown: string) {
	return renderToString(jsx(MarkdownView, { markdown }))
}

test('renders common markdown constructs as HTML elements', async () => {
	const html = await renderMarkdown(
		[
			'# Title',
			'',
			'#### Deep heading',
			'',
			'Some **bold** and *italic* and ~~gone~~ and `inline code` text.',
			'',
			'> a quote',
			'',
			'- first',
			'- [x] done task',
			'',
			'5. five',
			'6. six',
			'',
			'| Name | Count |',
			'| :--- | ----: |',
			'| a    | 1     |',
			'',
			'```js',
			'const x = 1',
			'```',
			'',
			'---',
			'',
			'Entities: &amp; &#65; stay characters.',
		].join('\n'),
	)

	// Headings are demoted below the page-owned h1/h2 and clamped at h6.
	expect(html).toContain('<h3>Title</h3>')
	expect(html).toContain('<h6>Deep heading</h6>')
	expect(html).toContain('<strong>bold</strong>')
	expect(html).toContain('<em>italic</em>')
	expect(html).toContain('<del>gone</del>')
	expect(html).toContain('<code>inline code</code>')
	expect(html).toContain('<blockquote>')
	expect(html).toContain('<li><span>first</span></li>')
	expect(html).toContain('<input type="checkbox" disabled checked />')
	expect(html).toContain('start="5"')
	expect(html).toContain('>Name</th>')
	expect(html).toContain('>a</td>')
	expect(html).toContain('<pre><code>const x = 1</code></pre>')
	expect(html).toContain('<hr')
	// Character references decode to text, then re-escape safely on output.
	expect(html).toContain('Entities: &amp; A stay characters.')
})

test('raw HTML is shown as escaped text, never as markup', async () => {
	const html = await renderMarkdown(
		[
			'<script>alert(1)</script>',
			'',
			'inline <img src="https://evil.example/x.png" onerror="alert(1)"> html',
			'',
			'<iframe src="https://evil.example"></iframe>',
		].join('\n'),
	)

	expect(html).not.toContain('<script')
	expect(html).not.toContain('<img')
	expect(html).not.toContain('<iframe')
	expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
	expect(html).toContain('&lt;img src=')
})

test('markdown images never emit <img> and render as links instead', async () => {
	const html = await renderMarkdown(
		'![badge](https://img.example/badge.svg) and ![local](/logo.png)',
	)

	expect(html).not.toContain('<img')
	expect(html).toContain(
		'<a href="https://img.example/badge.svg" target="_blank" rel="noopener noreferrer nofollow ugc">badge</a>',
	)
	// Relative image URL is unsafe, so only its alt text remains.
	expect(html).toContain('<span>local</span>')
	expect(html).not.toContain('/logo.png')
})

test('unsafe link targets render as plain text without an anchor', async () => {
	const html = await renderMarkdown(
		[
			'[bad-proto](javascript:alert(1))',
			'',
			'[data-proto](data:text/html,hi)',
			'',
			'[relative](/account/secrets)',
			'',
			'[package-endpoint](https://heykody.dev/@mallory/packages/tracker/app)',
			'',
			'[good](https://example.com/docs) and <https://example.com/auto>',
		].join('\n'),
	)

	expect(html).not.toContain('javascript:')
	expect(html).not.toContain('data:text/html')
	expect(html).not.toContain('/account/secrets')
	expect(html).not.toContain('@mallory')
	expect(html).toContain('<span>bad-proto</span>')
	expect(html).toContain('<span>package-endpoint</span>')
	expect(html).toContain(
		'<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow ugc">good</a>',
	)
	expect(html).toContain('https://example.com/auto</a>')
})

test('getSafeMarkdownLinkHref allowlists protocols and blocks user-scope paths', () => {
	expect(getSafeMarkdownLinkHref('https://example.com/a')).toBe(
		'https://example.com/a',
	)
	expect(getSafeMarkdownLinkHref('http://example.com')).toBe(
		'http://example.com/',
	)
	expect(getSafeMarkdownLinkHref('mailto:kody@example.com')).toBe(
		'mailto:kody@example.com',
	)
	expect(getSafeMarkdownLinkHref('javascript:alert(1)')).toBe(null)
	expect(getSafeMarkdownLinkHref('vbscript:x')).toBe(null)
	expect(getSafeMarkdownLinkHref('data:text/html,hi')).toBe(null)
	expect(getSafeMarkdownLinkHref('/relative/path')).toBe(null)
	expect(getSafeMarkdownLinkHref('relative/path')).toBe(null)
	expect(getSafeMarkdownLinkHref('//protocol-relative.example')).toBe(null)
	expect(
		getSafeMarkdownLinkHref('https://heykody.dev/@user/packages/app'),
	).toBe(null)
	expect(getSafeMarkdownLinkHref('https://other.example/@user/anything')).toBe(
		null,
	)
	// Repeated slashes collapse in worker routing (`split('/').filter(Boolean)`),
	// so `//@user` must be refused too.
	expect(
		getSafeMarkdownLinkHref('https://heykody.dev//@user/packages/app'),
	).toBe(null)
	expect(
		getSafeMarkdownLinkHref('https://heykody.dev///@user/packages/app'),
	).toBe(null)
	// Percent-encoded (and nested-encoded) user scopes must be refused:
	// URL.pathname does not decode, but the server does.
	expect(
		getSafeMarkdownLinkHref('https://heykody.dev/%40user/packages/app'),
	).toBe(null)
	expect(
		getSafeMarkdownLinkHref('https://heykody.dev/%2540user/packages/app'),
	).toBe(null)
	expect(
		getSafeMarkdownLinkHref('https://heykody.dev/%25252540user/packages/app'),
	).toBe(null)
	expect(getSafeMarkdownLinkHref('https://heykody.dev/%2F@user/x')).toBe(null)
	// Undecodable paths fail closed.
	expect(getSafeMarkdownLinkHref('https://heykody.dev/%E0%A4%A')).toBe(null)
	// Benign encoded paths that decode to non-user-scope stay allowed.
	expect(getSafeMarkdownLinkHref('https://example.com/a%20b')).toBe(
		'https://example.com/a%20b',
	)
})
