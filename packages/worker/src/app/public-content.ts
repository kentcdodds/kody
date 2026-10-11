import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { publicOgPages } from '#universal/og-pages.ts'
import { listBlogPosts } from '#worker/blog/catalog.ts'

/** Public discovery excludes account access and recovery screens. */
const accountPaths = new Set(['/login', '/signup', '/reset-password'])

export function listPublicWebsitePages() {
	return [
		...acquisitionPageSummaries,
		...Object.values(publicOgPages)
			.filter((page) => !accountPaths.has(page.path))
			.map((page) => ({
				path: page.path,
				title: page.ogTitle,
				description: page.ogDescription,
			})),
		{
			path: '/docs',
			title: 'Documentation',
			description: 'Learn how to use Kody.',
		},
		{
			path: '/docs/connect',
			title: 'Connect a provider',
			description: 'Set up connections to your accounts.',
		},
		{
			path: '/auth.md',
			title: 'Connect your agent',
			description: 'OAuth and MCP endpoint details.',
		},
	]
}

export function listPublicBlogPages() {
	return listBlogPosts().map((post) => ({
		path: `/blog/${post.slug}`,
		title: post.title,
		description: post.description,
		lastmod: post.date,
	}))
}
