import { expect, test } from 'vitest'
import { rewriteRelativeGuideLinks } from './rewrite-relative-links.ts'

const knownSlugs = new Set(['oauth', 'integration-bootstrap', 'google'])

test('rewriteRelativeGuideLinks maps guide files to /docs routes and repo docs to GitHub', () => {
	const body = [
		'Read [integration-bootstrap.md](./integration-bootstrap.md) first.',
		'Also [oauth](oauth.md#redirect-uri) and [google](providers/google.md).',
		'See [packages](../use/packages.md#ambient-storage-in-package-code).',
		'External [docs](https://developers.google.com/identity) stay put.',
		'App links like [connect](/connect/oauth?provider=google) stay put.',
		'Anchors [scopes](#scopes) stay put.',
	].join('\n')

	const rewritten = rewriteRelativeGuideLinks({
		body,
		sourceDir: 'docs/guides',
		knownSlugs,
	})

	expect(rewritten).toContain('](/docs/integration-bootstrap)')
	expect(rewritten).toContain('](/docs/oauth#redirect-uri)')
	expect(rewritten).toContain('](/docs/google)')
	expect(rewritten).toContain(
		'](https://github.com/kentcdodds/kody/blob/main/docs/use/packages.md#ambient-storage-in-package-code)',
	)
	expect(rewritten).toContain('](https://developers.google.com/identity)')
	expect(rewritten).toContain('](/connect/oauth?provider=google)')
	expect(rewritten).toContain('](#scopes)')
	expect(rewritten).not.toContain('](./')
	expect(rewritten).not.toContain('](../')

	const withTitles = rewriteRelativeGuideLinks({
		body: 'Read [OAuth](./oauth.md "OAuth guide") and [g](providers/google.md \'G\').',
		sourceDir: 'docs/guides',
		knownSlugs,
	})
	expect(withTitles).toContain('](/docs/oauth "OAuth guide")')
	expect(withTitles).toContain("](/docs/google 'G')")

	const fromProviderDir = rewriteRelativeGuideLinks({
		body: 'See [oauth](../oauth.md) and [google](./google.md).',
		sourceDir: 'docs/guides/providers',
		knownSlugs,
	})
	expect(fromProviderDir).toContain('](/docs/oauth)')
	expect(fromProviderDir).toContain('](/docs/google)')
})

test('rewriteRelativeGuideLinks sends the introduction to /docs and merged files to their alias', () => {
	const rewritten = rewriteRelativeGuideLinks({
		body: [
			'Start with [What is Kody?](./what-is-kody.md).',
			'Then [happy path](./integration-backed-app-happy-path.md)',
			'or [one heading](./integration-backed-app-happy-path.md#avoid-this-detour).',
		].join('\n'),
		sourceDir: 'docs/guides',
		knownSlugs: new Set(['what-is-kody', 'package-apps']),
	})
	expect(rewritten).toContain('](/docs)')
	expect(rewritten).not.toContain('](/docs/what-is-kody)')
	expect(rewritten).toContain(
		'](/docs/package-apps#after-an-integration-smoke-test)',
	)
	// An authored fragment wins over the alias default.
	expect(rewritten).toContain('](/docs/package-apps#avoid-this-detour)')
})
