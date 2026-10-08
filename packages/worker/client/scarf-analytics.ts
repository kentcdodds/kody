import { listDocsNavSlugs } from '#universal/docs-nav.ts'

// Public pixel owned by the Kody organization. Never load on preview hosts.
const pixelId = '45bb291d-1173-47ce-a996-7214c1787914'
const publicPaths = new Set([
	'/',
	'/pricing',
	'/faq',
	'/case-studies',
	'/blog',
	'/docs',
	...listDocsNavSlugs({ includeAdmin: false }).map((slug) => `/docs/${slug}`),
])

export function scarfPageUrl(href: string): string | null {
	const url = new URL(href)
	if (url.origin !== 'https://kody.codes') return null
	if (
		!publicPaths.has(url.pathname) &&
		!/^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname)
	)
		return null
	// Never send query strings, fragments, referrers, account IDs, or content.
	return `${url.origin}${url.pathname}`
}

export function createScarfPageTracker() {
	let previousPage: string | null = null
	return function trackScarfPage() {
		try {
			const page = scarfPageUrl(window.location.href)
			if (page === previousPage) return
			previousPage = page
			if (
				!page ||
				navigator.doNotTrack === '1' ||
				(navigator as Navigator & { globalPrivacyControl?: boolean })
					.globalPrivacyControl
			)
				return
			const pixel = new Image()
			pixel.referrerPolicy = 'no-referrer'
			const url = new URL('https://static.scarf.sh/a.png')
			url.searchParams.set('x-pxid', pixelId)
			url.searchParams.set('Page', page)
			// A return visit must fetch again instead of reusing the document's image.
			url.searchParams.set('_', crypto.randomUUID())
			pixel.src = url.toString()
		} catch {
			// Analytics must not interrupt navigation or fail in restricted browsers.
		}
	}
}
