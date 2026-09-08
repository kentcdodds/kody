import { expect, test } from 'vitest'
import { getSlugFromPathname } from './blog-post-path.ts'

test('blog post paths are /blog/:slug only, not listing, feeds, or APIs', () => {
	expect(getSlugFromPathname('/blog/hello-world')).toBe('hello-world')
	expect(getSlugFromPathname('/blog/hello-world/')).toBe('hello-world')
	expect(getSlugFromPathname('/blog/early%20kody%20users')).toBe(
		'early kody users',
	)

	expect(getSlugFromPathname('/blog')).toBeNull()
	expect(getSlugFromPathname('/blog/')).toBeNull()
	expect(getSlugFromPathname('/')).toBeNull()
	expect(getSlugFromPathname('/pricing')).toBeNull()

	expect(getSlugFromPathname('/blog/rss.xml')).toBeNull()
	expect(getSlugFromPathname('/blog/hello-world.json')).toBeNull()
	expect(getSlugFromPathname('/blog/nested/slug')).toBeNull()
	expect(getSlugFromPathname('/blog/foo%2Fbar')).toBeNull()
	expect(getSlugFromPathname('/blog/hello%2Ejson')).toBeNull()
	expect(getSlugFromPathname('/blog/%')).toBeNull()
})
