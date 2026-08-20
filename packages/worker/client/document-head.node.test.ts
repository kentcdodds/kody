import { expect, test } from 'vitest'
import { clientRoutes } from '#client/routes/index.tsx'
import {
	absolutizeDocumentHead,
	NOT_FOUND_DOCUMENT_TITLE,
	resolveDocumentHead,
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
		.replaceAll('(', '')
		.replaceAll(')', '')
		.split('/')
		.map((segment) => {
			if (segment.startsWith(':') || segment.startsWith('*')) return 'sample'
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

test('guide artwork controls the canonical Open Graph image', () => {
	const descriptor = resolveDocumentHead('/guides/kody-factory', {
		guideDetail: {
			ok: true,
			slug: 'kody-factory',
			id: 'kody_factory',
			title: 'The Kody factory map',
			summary: 'Map the software factory.',
			category: 'platform',
			image: '/images/kody-factory-map.webp',
			imageAlt: 'Kody presenting a map of the software factory',
			ogImage: '/images/kody-factory-map-og.jpg',
			provider: null,
			lastVerified: null,
			body: '# The Kody factory map',
		},
	})
	const head = absolutizeDocumentHead(descriptor, 'https://kody.codes')

	expect(head.canonicalUrl).toBe('https://kody.codes/guides/kody-factory')
	expect(head.og.imageUrl).toBe('https://kody.codes/guides/kody-factory/og.png')
})
