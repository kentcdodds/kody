import { expect, test } from 'vitest'
import {
	absolutizeDocumentHead,
	DEFAULT_DOCUMENT_TITLE,
	NOT_FOUND_DOCUMENT_TITLE,
	resolveDocumentHead,
	resolveDocumentTitle,
} from './document-head.ts'

test('resolveDocumentHead covers static titles, dynamic OG, fallbacks, and absolutized URLs', () => {
	expect(resolveDocumentTitle('/')).toBe(DEFAULT_DOCUMENT_TITLE)
	expect(resolveDocumentTitle('/account')).toBe('Account')
	expect(resolveDocumentTitle('/account/secrets')).toBe('Secrets')
	expect(resolveDocumentTitle('/account/secrets/new')).toBe('Secrets')
	expect(resolveDocumentTitle('/account/billing')).toBe('Billing')
	expect(resolveDocumentTitle('/account/usage')).toBe('Usage')
	expect(
		resolveDocumentTitle('/account/package-invocation-tokens/token-1'),
	).toBe('Package invocation tokens')
	expect(resolveDocumentTitle('/blog')).toBe('Blog')
	expect(resolveDocumentTitle('/community')).toBe('Community packages')
	expect(resolveDocumentTitle('/timeline')).toBe('Timeline')
	expect(resolveDocumentTitle('/admin/users')).toBe('Admin users')
	expect(resolveDocumentTitle('/privacy')).toBe('Privacy')
	expect(resolveDocumentTitle('/terms')).toBe('Terms')

	const home = resolveDocumentHead('/')
	expect(home.og?.title).toBe("Kody — your assistant's home")
	expect(home.og?.imagePath).toBe('/og/home.png')
	expect(home.canonicalPath).toBe('/')

	const login = resolveDocumentHead('/login')
	expect(login.og?.title).toBe('Sign in — Kody')
	expect(login.title).toBe(DEFAULT_DOCUMENT_TITLE)

	const blog = resolveDocumentHead('/blog')
	expect(blog.links).toEqual([
		{
			rel: 'alternate',
			type: 'application/rss+xml',
			title: 'Kody Blog RSS',
			hrefPath: '/blog/rss.xml',
		},
	])

	const blogPost = resolveDocumentHead('/blog/hello-world', {
		blogPost: {
			ok: true,
			slug: 'hello-world',
			title: 'Hello World',
			date: '2026-01-01',
			description: 'A post',
			body: '# Hello',
		},
	})
	expect(blogPost.title).toBe('Hello World — Kody Blog')
	expect(blogPost.og).toEqual({
		title: 'Hello World — Kody Blog',
		description: 'A post',
		imagePath: '/blog/hello-world/og.png',
	})

	const community = resolveDocumentHead('/community/listing-1', {
		communityDetailShell: {
			ok: true,
			listingId: 'listing-1',
			name: 'Calendar helper',
			description: 'Helps with calendars.',
			forkPrompt: 'fork',
			loggedIn: false,
			viewerIsAdmin: false,
			trusted: false,
			featured: false,
			readmeContent: null,
			starCount: 0,
			starredByViewer: false,
		},
	})
	expect(community.title).toBe('Calendar helper — Kody community package')
	expect(community.og?.description).toBe('Helps with calendars.')
	expect(community.og?.imagePath).toBe('/community/listing-1/og.png')

	const publicProfile = resolveDocumentHead('/@kent', {
		profileShell: {
			ok: true,
			username: 'kent',
			displayName: 'Kent C. Dodds',
			bio: 'Builder of things.',
			isSelf: false,
			loggedIn: false,
			isFollowing: false,
			visibility: 'public',
		},
	})
	expect(publicProfile.title).toBe('Kent C. Dodds')
	expect(publicProfile.og?.title).toBe('Kent C. Dodds (@kent) — Kody')
	expect(publicProfile.og?.description).toBe('Builder of things.')

	const privateProfile = resolveDocumentHead('/@kent', {
		profileShell: {
			ok: true,
			username: 'kent',
			displayName: 'Kent C. Dodds',
			bio: 'Hidden bio',
			isSelf: false,
			loggedIn: false,
			isFollowing: false,
			visibility: 'private',
		},
	})
	expect(privateProfile.title).toBe('Kent C. Dodds')
	expect(privateProfile.og).toBeUndefined()

	expect(
		resolveDocumentTitle('/@missing', {
			profileShell: { ok: false, unavailable: true },
		}),
	).toBe('Profile unavailable')

	expect(resolveDocumentHead('/blog/hello-world')).toEqual({ title: 'Blog' })
	expect(resolveDocumentHead('/community/listing-1')).toEqual({
		title: 'Community packages',
	})
	expect(resolveDocumentHead('/@kent').title).toBe('@kent')
	expect(resolveDocumentHead('/this-route-does-not-exist').title).toBe(
		NOT_FOUND_DOCUMENT_TITLE,
	)

	const resolved = absolutizeDocumentHead(
		resolveDocumentHead('/blog', undefined),
		'https://heykody.dev',
	)
	expect(resolved.canonicalUrl).toBe('https://heykody.dev/blog')
	expect(resolved.og?.imageUrl).toBe('https://heykody.dev/og/blog.png')
	expect(resolved.links?.[0]?.href).toBe('https://heykody.dev/blog/rss.xml')
})
