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
