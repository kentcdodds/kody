import { expect, test } from 'vitest'
import {
	docsCurrentPageLabel,
	docsIntroSlug,
	isDocsPagePath,
	resolveDocsNavSection,
} from './docs-nav.ts'

test('isDocsPagePath covers the docs shell and rejects lookalike paths', () => {
	expect(isDocsPagePath('/docs')).toBe(true)
	expect(isDocsPagePath('/docs/')).toBe(true)
	expect(isDocsPagePath('/docs/oauth')).toBe(true)
	expect(isDocsPagePath('/docs/connect')).toBe(true)
	expect(isDocsPagePath('/docs/oauth.md')).toBe(true)
	expect(isDocsPagePath('/documentation')).toBe(false)
	expect(isDocsPagePath('/blog')).toBe(false)
	expect(isDocsPagePath('/account')).toBe(false)
})

test('resolveDocsNavSection maps connect to providers and slugs to their section', () => {
	expect(resolveDocsNavSection('connect')?.id).toBe('providers')
	expect(resolveDocsNavSection('github')?.id).toBe('providers')
	expect(resolveDocsNavSection(docsIntroSlug)?.id).toBe('introduction')
	expect(resolveDocsNavSection('oauth')?.id).toBe('integrations')
	expect(resolveDocsNavSection('missing-doc')).toBeNull()
})

test('docsCurrentPageLabel uses the connect branch and falls back for unknown slugs', () => {
	expect(docsCurrentPageLabel('connect')).toBe('Connect a provider')
	expect(docsCurrentPageLabel('missing-doc')).toBe('Docs')
})
