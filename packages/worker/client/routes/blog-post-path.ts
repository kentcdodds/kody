import { routes } from '#universal/routes.ts'

/**
 * Post slug for `/blog/:slug` only. The `/blog` listing, `rss.xml`, `.json`
 * APIs, and nested paths are not posts. The shell calls this to classify
 * every pathname, so it must stay a tiny module — importing `blog-post.tsx`
 * would pull Shiki onto `/`.
 */
export function getSlugFromPathname(pathname: string) {
	const prefix = `${routes.blog.href()}/`
	if (!pathname.startsWith(prefix)) return null
	let slug: string
	try {
		slug = decodeURIComponent(pathname.slice(prefix.length).replace(/\/$/, ''))
	} catch {
		// Malformed percent-encoding (`/blog/%`) throws. The shell calls this to
		// classify every pathname, so a throw here would take the whole page
		// down instead of just missing a post.
		return null
	}
	// Dots mark non-post paths under /blog (rss.xml, .json APIs); real post
	// slugs are kebab-case and never contain one.
	if (!slug || slug.includes('/') || slug.includes('.')) return null
	return slug
}
