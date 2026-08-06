import { expect, test } from 'vitest'
import { rewriteRelativeGuideLinks } from './rewrite-relative-links.ts'

const knownSlugs = new Set(['oauth', 'integration-bootstrap', 'google'])

test('rewriteRelativeGuideLinks maps guide files to /guides routes and repo docs to GitHub', () => {
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

	expect(rewritten).toContain('](/guides/integration-bootstrap)')
	expect(rewritten).toContain('](/guides/oauth#redirect-uri)')
	expect(rewritten).toContain('](/guides/google)')
	expect(rewritten).toContain(
		'](https://github.com/kentcdodds/kody/blob/main/docs/use/packages.md#ambient-storage-in-package-code)',
	)
	expect(rewritten).toContain('](https://developers.google.com/identity)')
	expect(rewritten).toContain('](/connect/oauth?provider=google)')
	expect(rewritten).toContain('](#scopes)')
	expect(rewritten).not.toContain('](./')
	expect(rewritten).not.toContain('](../')
})

test('rewriteRelativeGuideLinks preserves markdown link titles', () => {
	const rewritten = rewriteRelativeGuideLinks({
		body: 'Read [OAuth](./oauth.md "OAuth guide") and [g](providers/google.md \'G\').',
		sourceDir: 'docs/guides',
		knownSlugs,
	})
	expect(rewritten).toContain('](/guides/oauth "OAuth guide")')
	expect(rewritten).toContain("](/guides/google 'G')")
})

test('rewriteRelativeGuideLinks resolves provider-directory sources against their own dir', () => {
	const rewritten = rewriteRelativeGuideLinks({
		body: 'See [oauth](../oauth.md) and [google](./google.md).',
		sourceDir: 'docs/guides/providers',
		knownSlugs,
	})
	expect(rewritten).toContain('](/guides/oauth)')
	expect(rewritten).toContain('](/guides/google)')
})
