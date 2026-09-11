import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	MarkdownView,
	getSafeMarkdownLinkHref,
	renderMarkdownNodes,
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
	expect(html).toContain('data-markdown-table')
	expect(html).toContain('data-markdown-table-compact-last')
	expect(html).toContain('class="shiki')
	expect(html).toContain('const')
	expect(html).toContain('<hr')
	// Character references decode to text, then re-escape safely on output.
	expect(html).toContain('Entities: &amp; A stay characters.')
})

test('markdown safety escapes raw HTML, never emits images, and drops unsafe links', async () => {
	const html = await renderMarkdown(
		[
			'<script>alert(1)</script>',
			'',
			'inline <img src="https://evil.example/x.png" onerror="alert(1)"> html',
			'',
			'<iframe src="https://evil.example"></iframe>',
			'',
			'![badge](https://img.example/badge.svg) and ![local](/logo.png)',
			'',
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

	expect(html).not.toContain('<script')
	expect(html).not.toContain('<img')
	expect(html).not.toContain('<iframe')
	expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
	// Comment-only HTML (guide agent notes) renders as nothing — it must not
	// leak into the page as literal text.
	const withComments = await renderMarkdown(
		'before\n\n<!--\nagent notes: hidden\n-->\n\nafter <!-- inline note --> end',
	)
	expect(withComments).toContain('before')
	expect(withComments).toContain('after')
	expect(withComments).not.toContain('agent notes')
	expect(withComments).not.toContain('inline note')
	expect(withComments).not.toContain('&lt;!--')
	expect(html).toContain('&lt;img src=')
	expect(html).toContain(
		'<a href="https://img.example/badge.svg" target="_blank" rel="noopener noreferrer nofollow ugc">badge</a>',
	)
	expect(html).toContain('<span>local</span>')
	expect(html).not.toContain('/logo.png')
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

test('package README imageBaseHref emits img only for in-repo relative images', async () => {
	const markdown = [
		'![poster](./docs/poster.png)',
		'',
		'![nested](poster.png)',
		'',
		'![remote](https://img.example/badge.svg)',
		'',
		'![escape](../secret.png)',
		'',
		'![code](./src/index.ts)',
	].join('\n')

	const withAssets = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				imageBaseHref: '/@kody/doom/assets',
				imageFromDirectory: '',
			}),
		}),
	)
	expect(withAssets).toContain(
		'<img src="/@kody/doom/assets/docs/poster.png" alt="poster"',
	)
	expect(withAssets).toContain(
		'<img src="/@kody/doom/assets/poster.png" alt="nested"',
	)
	expect(withAssets).not.toContain('<img src="https://img.example')
	expect(withAssets).toContain(
		'<a href="https://img.example/badge.svg" target="_blank" rel="noopener noreferrer nofollow ugc">remote</a>',
	)
	expect(withAssets).toContain('<span>escape</span>')
	expect(withAssets).not.toContain('secret.png')
	expect(withAssets).not.toContain('src/index.ts')

	const fromDocs = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes('![poster](./poster.png)', {
				imageBaseHref: '/@kody/doom/assets',
				imageFromDirectory: 'docs',
			}),
		}),
	)
	expect(fromDocs).toContain(
		'<img src="/@kody/doom/assets/docs/poster.png" alt="poster"',
	)

	const defaultPolicy = await renderMarkdown('![poster](./docs/poster.png)')
	expect(defaultPolicy).not.toContain('<img')
	expect(defaultPolicy).toContain('<span>poster</span>')
})

test('first-party render options keep authored heading levels and drop the ugc rel', async () => {
	const markdown = [
		'# Top',
		'',
		'## Section',
		'',
		'###### Deep',
		'',
		'[docs](https://example.com/docs)',
	].join('\n')

	const firstParty = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
			}),
		}),
	)
	// h1 stays page-owned even at offset 0; deep headings clamp at h6.
	expect(firstParty).toContain('<h2>Top</h2>')
	expect(firstParty).toContain('<h2>Section</h2>')
	expect(firstParty).toContain('<h6>Deep</h6>')
	expect(firstParty).toContain(
		'<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>',
	)

	// The default (third-party README) policy is unchanged.
	const thirdParty = await renderToString(
		jsx('div', { children: renderMarkdownNodes(markdown) }),
	)
	expect(thirdParty).toContain('<h3>Top</h3>')
	expect(thirdParty).toContain('<h4>Section</h4>')
	expect(thirdParty).toContain('rel="noopener noreferrer nofollow ugc"')
})

test('first-party headingIds emit unique kebab-case heading ids', async () => {
	const html = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(
				[
					'## Josh Tomaino',
					'',
					'## Josh Tomaino',
					'',
					'## Jett Hays',
					'',
					'## Gabriel Alegría',
				].join('\n'),
				{ headingOffset: 0, headingIds: true },
			),
		}),
	)
	expect(html).toContain('<h2 id="josh-tomaino" aria-label="Josh Tomaino">')
	expect(html).toContain('href="#josh-tomaino"')
	expect(html).toContain('data-heading-permalink=""')
	expect(html).toContain('aria-label="Link to this section"')
	expect(html).toContain('data-heading-anchor=""')
	expect(html).toContain('data-heading-text=""')
	expect(html).toContain('<span data-heading-text="">Josh Tomaino</span>')
	const joshPermalink = html.match(
		/<a href="#josh-tomaino"[^>]*>[\s\S]*?<\/a>/,
	)?.[0]
	expect(joshPermalink).toBeDefined()
	expect(joshPermalink).toContain('aria-label="Link to this section"')
	expect(joshPermalink).not.toContain('aria-label="Josh Tomaino"')
	expect(html).toContain('<h2 id="josh-tomaino-2" aria-label="Josh Tomaino">')
	expect(html).toContain('href="#josh-tomaino-2"')
	expect(html).toContain('<h2 id="jett-hays" aria-label="Jett Hays">')
	expect(html).toContain(
		'<h2 id="gabriel-alegria" aria-label="Gabriel Alegría">',
	)
})

test('heading permalinks stay beside inline heading links instead of wrapping them', async () => {
	const html = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(
				'## Read [the guide](https://example.com/guide)',
				{ headingOffset: 0, headingIds: true },
			),
		}),
	)
	expect(html).toContain(
		'id="read-the-guide-https-example.com-guide" aria-label="Read the guide"',
	)
	expect(html).toContain('href="#read-the-guide-https-example.com-guide"')
	expect(html).toContain('href="https://example.com/guide"')
	const permalink = html.match(
		/<a href="#read-the-guide-https-example.com-guide"[^>]*>[\s\S]*?<\/a>/,
	)?.[0]
	expect(permalink).toBeDefined()
	expect(permalink).toContain('aria-label="Link to this section"')
	expect(permalink).not.toContain('aria-label="Read the guide"')
	expect(permalink?.match(/<a /g)).toHaveLength(1)
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
	// The per-user package-app subdomain mounts apps at `/packages/...`, so
	// that path shape is refused on every host too (this module cannot know
	// the deployment's package-app domain; same trade-off as the `/@` rule).
	expect(
		getSafeMarkdownLinkHref('https://mallory.kodyapps.dev/packages/tracker'),
	).toBe(null)
	expect(
		getSafeMarkdownLinkHref(
			'https://mallory.kodyapps.dev/packages/tracker/app',
		),
	).toBe(null)
	expect(getSafeMarkdownLinkHref('https://other.example/packages/x')).toBe(null)
	expect(getSafeMarkdownLinkHref('https://other.example//packages/x')).toBe(
		null,
	)
	expect(getSafeMarkdownLinkHref('https://other.example/%70ackages/x')).toBe(
		null,
	)
	// Paths that merely contain (not start with) a `packages` segment stay
	// allowed — only the mount shape is refused.
	expect(
		getSafeMarkdownLinkHref('https://github.com/orgs/example/packages'),
	).toBe('https://github.com/orgs/example/packages')
})

test('first-party guides render tip callouts and details; untrusted markdown stays escaped', async () => {
	const markdown = [
		'> [!TIP]',
		'> Prefer a [fork](/docs/package-lifecycle) for most use cases.',
		'',
		'<details>',
		'<summary>What is the difference between forking and sharing?</summary>',
		'',
		'**Fork** copies the package. **Share** leaves it in your account.',
		'',
		'</details>',
		'',
		'<details onclick="alert(1)">',
		'<summary>Bad</summary>',
		'',
		'Nope',
		'',
		'</details>',
	].join('\n')

	const firstParty = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				linkPolicy: 'first-party',
				headingOffset: 0,
			}),
		}),
	)
	expect(firstParty).toContain('data-doc-callout="tip"')
	expect(firstParty).toContain('<strong>Tip</strong>')
	expect(firstParty).toContain('href="/docs/package-lifecycle"')
	expect(firstParty).not.toContain('[!TIP]')
	expect(firstParty).toContain('<details')
	expect(firstParty).toContain('data-doc-disclosure')
	expect(firstParty).toContain(
		'<summary>What is the difference between forking and sharing?</summary>',
	)
	expect(firstParty).toContain('<strong>Fork</strong>')
	expect(firstParty).toContain('<strong>Share</strong>')
	expect(firstParty).toContain('&lt;details onclick="alert(1)"&gt;')
	expect(firstParty).not.toContain('<details onclick')

	const untrusted = await renderMarkdown(markdown)
	expect(untrusted).toContain('<blockquote>')
	expect(untrusted).toContain('[!TIP]')
	expect(untrusted).not.toContain('data-doc-callout')
	expect(untrusted).not.toContain('<details')
	expect(untrusted).toContain('&lt;details')
	expect(untrusted).toContain('&lt;summary')
})

test('markdown tables keep last-column nowrap only when every last cell is a short label', async () => {
	const compact = await renderMarkdown(
		[
			'| You want to | Use |',
			'| --- | --- |',
			'| Keep working code | A **package** |',
			'| Sign in so code can act as you | An **integration** |',
		].join('\n'),
	)
	expect(compact).toContain('data-markdown-table-compact-last')

	const descriptive = await renderMarkdown(
		[
			'| File | Topic |',
			'| --- | --- |',
			'| oauth.md | Start here for third-party OAuth redirect URI and params |',
		].join('\n'),
	)
	expect(descriptive).toContain('data-markdown-table=""')
	expect(descriptive).not.toContain('data-markdown-table-compact-last=""')
})
