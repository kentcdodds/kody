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

test('guide artwork and blog posts route Open Graph cards through generated paths', () => {
	const guide = absolutizeDocumentHead(
		resolveDocumentHead('/guides/kody-factory', {
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
		}),
		'https://kody.codes',
	)
	expect(guide.canonicalUrl).toBe('https://kody.codes/guides/kody-factory')
	expect(guide.og.imageUrl).toBe(
		'https://kody.codes/guides/kody-factory/og.png',
	)

	const blogBase = {
		ok: true as const,
		slug: 'kody-vs-executor',
		title: 'Kody vs Executor?',
		date: '2026-08-20',
		description: 'Kody is the runtime. Executor is the gateway.',
		placeholder: false,
		image: '/images/kody-vs-executor.webp',
		imageAlt: 'Kody and the Executor logo size each other up.',
		body: 'Body',
		readNext: null,
	}

	for (const ogImage of [null, '/images/kody-vs-executor-og.jpg'] as const) {
		const head = absolutizeDocumentHead(
			resolveDocumentHead('/blog/kody-vs-executor', {
				blogPost: { ...blogBase, ogImage },
			}),
			'https://kody.codes',
		)
		expect(head.canonicalUrl).toBe('https://kody.codes/blog/kody-vs-executor')
		expect(head.og.imageUrl).toBe(
			'https://kody.codes/blog/kody-vs-executor/og.png',
		)
	}

	const withoutArt = absolutizeDocumentHead(
		resolveDocumentHead('/blog/your-assistants-home', {
			blogPost: {
				ok: true,
				slug: 'your-assistants-home',
				title: "Your assistant's home",
				date: '2026-07-18',
				description: 'A home for your assistant.',
				placeholder: true,
				image: null,
				imageAlt: null,
				ogImage: null,
				body: 'Body',
				readNext: null,
			},
		}),
		'https://kody.codes',
	)
	expect(withoutArt.og.imageUrl).toBe(
		'https://kody.codes/blog/your-assistants-home/og.png',
	)
})
