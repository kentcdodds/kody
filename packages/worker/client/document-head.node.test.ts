import { expect, test } from 'vitest'
import { clientRoutes } from '#client/routes/index.tsx'
import {
	NOT_FOUND_DOCUMENT_TITLE,
	resolveDocumentTitle,
} from '#universal/document-head.ts'

/**
 * SPA navigations sync `<title>` from `document-head.ts` only. SSR can still
 * pass a `title` override into `renderAppPage`, which is why a missing registry
 * entry shows the correct title on refresh and "Not found" on client nav.
 * Keep every `clientRoutes` pattern registered so that mismatch cannot regress.
 */

function concretePathForPattern(pattern: string) {
	return pattern
		.split('/')
		.map((segment) => {
			if (segment.startsWith(':')) return 'sample'
			if (segment === '*') return 'sample'
			return segment
		})
		.join('/')
}

test('every client route resolves a document title other than Not found', () => {
	const missing: Array<string> = []
	for (const pattern of Object.keys(clientRoutes)) {
		const pathname = concretePathForPattern(pattern)
		const title = resolveDocumentTitle(pathname)
		if (title === NOT_FOUND_DOCUMENT_TITLE) {
			missing.push(pattern)
		}
	}
	expect(missing, 'client routes missing document-head entries').toEqual([])
})

test('admin platform integrations SPA title matches the SSR override', () => {
	expect(resolveDocumentTitle('/admin/platform-integrations')).toBe(
		'Admin platform integrations',
	)
	expect(resolveDocumentTitle('/admin/platform-integrations/new')).toBe(
		'Admin platform integrations',
	)
	expect(resolveDocumentTitle('/admin/platform-integrations/github')).toBe(
		'Admin platform integrations',
	)
})

test('guides SPA titles resolve from the registry and loader data', () => {
	expect(resolveDocumentTitle('/guides')).toBe('Guides')
	expect(resolveDocumentTitle('/guides/oauth')).toBe('Guides')
	expect(
		resolveDocumentTitle('/guides/oauth', {
			guideDetail: {
				ok: true,
				slug: 'oauth',
				id: 'oauth',
				title: 'Connect with OAuth',
				summary: 'summary',
				category: 'platform',
				provider: null,
				lastVerified: null,
				body: '# Connect with OAuth\n',
			},
		}),
	).toBe('Connect with OAuth')
})
