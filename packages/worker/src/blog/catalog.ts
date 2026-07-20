import { parseBlogPostMarkdown, type BlogPost } from './parse-frontmatter.ts'
import helloKodyBlog from './posts/hello-kody-blog.md'

/**
 * Static post sources. When adding a post, drop a `.md` file under `posts/`
 * and add one import + entry here. The client never imports this module.
 */
const postSources: Array<{ slug: string; raw: string }> = [
	{ slug: 'hello-kody-blog', raw: helloKodyBlog },
]

function compareBlogPosts(a: BlogPost, b: BlogPost): number {
	if (a.date !== b.date) {
		return a.date < b.date ? 1 : -1
	}
	return a.order - b.order
}

function buildCatalog(): ReadonlyArray<BlogPost> {
	const posts = postSources.map(({ slug, raw }) =>
		parseBlogPostMarkdown(slug, raw),
	)
	return posts.sort(compareBlogPosts)
}

export const blogPosts: ReadonlyArray<BlogPost> = buildCatalog()

const postsBySlug = new Map(blogPosts.map((post) => [post.slug, post]))

export function getBlogPost(slug: string): BlogPost | null {
	return postsBySlug.get(slug) ?? null
}

export function listBlogPosts(): ReadonlyArray<BlogPost> {
	return blogPosts
}

/** Index / API summary shape (no markdown body). */
export type BlogPostSummary = {
	slug: string
	title: string
	date: string
	description: string
	order: number
}

export function toBlogPostSummary(post: BlogPost): BlogPostSummary {
	return {
		slug: post.slug,
		title: post.title,
		date: post.date,
		description: post.description,
		order: post.order,
	}
}
