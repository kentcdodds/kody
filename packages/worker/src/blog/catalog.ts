import { parseBlogPostMarkdown, type BlogPost } from './parse-frontmatter.ts'
import everyInstallIsAForkYouOwn from './posts/every-install-is-a-fork-you-own.md'
import gatewaysConnectHomesAccumulate from './posts/gateways-connect-homes-accumulate.md'
import selfServiceMeansOwnership from './posts/self-service-means-ownership.md'
import theAssistantThatCantLeakYourKeychain from './posts/the-assistant-that-cant-leak-your-keychain.md'
import theAutomationsYouNeverBuilt from './posts/the-automations-you-never-built.md'
import yourAssistantsHome from './posts/your-assistants-home.md'
import zeroInferenceCalls from './posts/zero-inference-calls.md'

/**
 * Static post sources. When adding a post, drop a `.md` file under `posts/`
 * and add one import + entry here. The client never imports this module.
 */
const postSources: Array<{ slug: string; raw: string }> = [
	{ slug: 'your-assistants-home', raw: yourAssistantsHome },
	{
		slug: 'gateways-connect-homes-accumulate',
		raw: gatewaysConnectHomesAccumulate,
	},
	{
		slug: 'the-assistant-that-cant-leak-your-keychain',
		raw: theAssistantThatCantLeakYourKeychain,
	},
	{ slug: 'zero-inference-calls', raw: zeroInferenceCalls },
	{
		slug: 'every-install-is-a-fork-you-own',
		raw: everyInstallIsAForkYouOwn,
	},
	{
		slug: 'the-automations-you-never-built',
		raw: theAutomationsYouNeverBuilt,
	},
	{ slug: 'self-service-means-ownership', raw: selfServiceMeansOwnership },
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
