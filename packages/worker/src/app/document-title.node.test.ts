import { expect, test } from 'vitest'
import {
	DEFAULT_DOCUMENT_TITLE,
	NOT_FOUND_DOCUMENT_TITLE,
	resolveDocumentTitle,
} from './document-title.ts'

test('resolveDocumentTitle returns static titles for known routes', () => {
	expect(resolveDocumentTitle('/')).toBe(DEFAULT_DOCUMENT_TITLE)
	expect(resolveDocumentTitle('/account')).toBe('Account')
	expect(resolveDocumentTitle('/blog')).toBe('Blog')
	expect(resolveDocumentTitle('/community')).toBe('Community packages')
	expect(resolveDocumentTitle('/timeline')).toBe('Timeline')
	expect(resolveDocumentTitle('/admin/users')).toBe('Admin users')
	expect(resolveDocumentTitle('/privacy')).toBe('Privacy')
})

test('resolveDocumentTitle prefers more specific account routes', () => {
	expect(resolveDocumentTitle('/account/secrets')).toBe('Secrets')
	expect(resolveDocumentTitle('/account/secrets/new')).toBe('Secrets')
	expect(resolveDocumentTitle('/account/billing')).toBe('Billing')
	expect(
		resolveDocumentTitle('/account/package-invocation-tokens/token-1'),
	).toBe('Package invocation tokens')
})

test('resolveDocumentTitle derives dynamic titles from loader data', () => {
	expect(
		resolveDocumentTitle('/blog/hello-world', {
			blogPost: {
				ok: true,
				slug: 'hello-world',
				title: 'Hello World',
				date: '2026-01-01',
				description: 'A post',
				body: '# Hello',
			},
		}),
	).toBe('Hello World — Kody Blog')

	expect(
		resolveDocumentTitle('/community/listing-1', {
			communityDetailShell: {
				ok: true,
				listingId: 'listing-1',
				name: 'Calendar helper',
				forkPrompt: 'fork',
				loggedIn: false,
				viewerIsAdmin: false,
				trusted: false,
				featured: false,
				readmeContent: null,
				starCount: 0,
				starredByViewer: false,
			},
		}),
	).toBe('Calendar helper — Kody community package')

	expect(
		resolveDocumentTitle('/@kent', {
			profileShell: {
				ok: true,
				username: 'kent',
				displayName: 'Kent C. Dodds',
				isSelf: false,
				loggedIn: false,
				isFollowing: false,
				visibility: 'public',
			},
		}),
	).toBe('Kent C. Dodds')

	expect(
		resolveDocumentTitle('/@missing', {
			profileShell: { ok: false, unavailable: true },
		}),
	).toBe('Profile unavailable')
})

test('resolveDocumentTitle falls back when dynamic loader data is missing', () => {
	expect(resolveDocumentTitle('/blog/hello-world')).toBe('Blog')
	expect(resolveDocumentTitle('/community/listing-1')).toBe(
		'Community packages',
	)
	expect(resolveDocumentTitle('/@kent')).toBe('@kent')
})

test('resolveDocumentTitle returns not-found for unknown paths', () => {
	expect(resolveDocumentTitle('/this-route-does-not-exist')).toBe(
		NOT_FOUND_DOCUMENT_TITLE,
	)
})
