import { expect, test } from 'vitest'
import { blogPostSlugs } from '#universal/blog-post-slugs.ts'
import { caseStudies } from '#universal/case-studies.ts'
import {
	getBlogPost,
	getReadNextBlogPost,
	listBlogPosts,
	normalizeMarkdownPhraseSource,
} from './catalog.ts'
import { parseBlogPostMarkdown } from './parse-frontmatter.ts'
import { buildBlogRssXml } from './rss.ts'

const markdown = (frontmatter: string, body = 'Body\n') =>
	`---\n${frontmatter}\n---\n\n${body}`
const baseFrontmatter = 'date: 2026-08-20\ndescription: Nope\norder: 1'

test('normalizeMarkdownPhraseSource strips blockquote markers and wrapping', () => {
	expect(
		normalizeMarkdownPhraseSource(
			'> funnels all my tools into one secure MCP\n> I can manage myself\n',
		),
	).toBe('funnels all my tools into one secure MCP I can manage myself ')
})

test('parseBlogPostMarkdown reads frontmatter and rejects invalid input', () => {
	expect(
		parseBlogPostMarkdown(
			'sample',
			markdown(
				'title: Sample title\ndate: 2026-07-18\ndescription: A short description for meta tags.\norder: 3',
				'# Hello\n\nBody paragraph.\n',
			),
		),
	).toEqual({
		slug: 'sample',
		title: 'Sample title',
		date: '2026-07-18',
		description: 'A short description for meta tags.',
		order: 3,
		placeholder: true,
		image: null,
		imageAlt: null,
		ogImage: null,
		body: '# Hello\n\nBody paragraph.\n',
	})

	expect(
		parseBlogPostMarkdown(
			'multiline',
			markdown(
				'title: Multiline\ndate: 2026-07-19\ndescription:\n  First sentence about the post.\n  Second sentence for meta tags.\norder: 2',
			),
		).description,
	).toBe('First sentence about the post. Second sentence for meta tags.')

	expect(
		parseBlogPostMarkdown(
			'reviewed',
			markdown(
				`title: Reviewed\n${baseFrontmatter}\nplaceholder: false\nimage: /images/kody-vs-executor.webp\nimageAlt: Kody and the Executor logo size each other up.`,
			),
		),
	).toMatchObject({
		placeholder: false,
		image: '/images/kody-vs-executor.webp',
		imageAlt: 'Kody and the Executor logo size each other up.',
		ogImage: null,
	})

	expect(
		parseBlogPostMarkdown(
			'custom-og',
			markdown(
				`title: Custom OG\n${baseFrontmatter}\nimage: /images/kody-vs-executor.webp\nimageAlt: Headline art.\nogImage: /images/kody-vs-executor.webp`,
			),
		).ogImage,
	).toBe('/images/kody-vs-executor.webp')

	for (const [frontmatter, error] of [
		[
			'title: Bad date\ndate: 07/20/2026\ndescription: Nope\norder: 1',
			/invalid frontmatter "date"/,
		],
		[baseFrontmatter, /missing frontmatter "title"/],
		[
			`title: Bad placeholder\n${baseFrontmatter}\nplaceholder: maybe`,
			/invalid frontmatter "placeholder"/,
		],
		[
			`title: Bad image\n${baseFrontmatter}\nimage: https://example.com/image.webp\nimageAlt: Nope`,
			/invalid frontmatter "image"/,
		],
	] as const) {
		expect(() => parseBlogPostMarkdown('bad', markdown(frontmatter))).toThrow(
			error,
		)
	}
})

function expectPost(
	slug: string,
	fields: Record<string, unknown>,
	phrases: Array<string>,
) {
	const post = getBlogPost(slug)
	expect(post).toMatchObject(fields)
	const body = normalizeMarkdownPhraseSource(post?.body ?? '')
	expect(phrases.filter((phrase) => !body.includes(phrase))).toEqual([])
}

test('blog catalog enumerates posts with required fields and slug lookup', () => {
	const posts = listBlogPosts()
	expect(posts.length).toBeGreaterThan(0)

	for (const post of posts) {
		expect(post.slug.length).toBeGreaterThan(0)
		expect(post.title.length).toBeGreaterThan(0)
		expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(post.description.length).toBeGreaterThan(0)
		expect(Number.isInteger(post.order)).toBe(true)
		expect(post.body.length).toBeGreaterThan(0)
		expect(getBlogPost(post.slug)).toEqual(post)
	}

	// Client-safe scarf allowlist must stay in lockstep with the catalog.
	expect([...blogPostSlugs].sort()).toEqual(
		posts.map((post) => post.slug).sort(),
	)

	expectPost(
		'early-kody-users',
		{ title: 'Case studies', date: '2026-09-08', placeholder: false },
		[
			'funnels all my tools into one secure MCP I can manage myself',
			"life or death for some of the world's most endangered species",
			'## Josh Tomaino',
			'## Jett Hays',
			'## Gabriel Alegría',
			'## Maciek Sitkowski',
			'shared layer behind how I work with agents',
		],
	)
	const caseStudiesPost = getBlogPost('early-kody-users')
	const caseStudiesBlogSource = normalizeMarkdownPhraseSource(
		caseStudiesPost?.body ?? '',
	)
	for (const study of caseStudies) {
		expect(caseStudiesBlogSource).toContain(
			study.body.replace(/\s+/g, ' ').trim(),
		)
		expect(caseStudiesPost?.body).toContain(`## ${study.name}`)
	}
	expectPost(
		'kody-vs-executor',
		{
			title: 'Kody vs Executor?',
			date: '2026-08-20',
			placeholder: false,
			image: '/images/kody-vs-executor.webp',
			ogImage: '/images/kody-vs-executor-og.jpg',
		},
		[
			'best of both worlds',
			'Leave one `execute`',
			'I wrote this on August 20, 2026. Both products will keep moving. The comparison is accurate as of that date.',
		],
	)
	expectPost(
		'openclaw-2-needs-a-home',
		{
			title: 'OpenClaw 2 needs a home',
			date: '2026-08-31',
			placeholder: true,
			image: '/images/openclaw-2-needs-a-home.webp',
			ogImage: '/images/openclaw-2-needs-a-home-og.jpg',
		},
		['openclaw mcp add kody'],
	)
	expectPost(
		'how-to-turn-agent-work-into-software-you-own',
		{
			title: 'How to turn agent work into software you own',
			date: '2026-08-31',
			order: 8,
			placeholder: true,
			image: '/images/kody-factory-map.webp',
			ogImage: '/images/kody-factory-map-og.jpg',
		},
		[
			'I call that the factory loop',
			'https://kody.codes/docs/how-kody-works',
			'https://kody.codes/onboarding',
			'https://kody.codes/blog/your-assistants-home',
			'https://kody.codes/blog/the-automations-you-never-built',
			'https://kody.codes/blog/zero-inference-calls',
			'https://kody.codes/blog/every-install-is-a-fork-you-own',
		],
	)
	expect(getBlogPost('does-not-exist')).toBeNull()

	const placeholderPosts = posts.filter(
		(post) =>
			post.slug !== 'kody-vs-executor' && post.slug !== 'early-kody-users',
	)
	expect(placeholderPosts.length).toBeGreaterThan(0)
	expect(placeholderPosts.every((post) => post.placeholder)).toBe(true)

	for (let index = 1; index < posts.length; index += 1) {
		const previous = posts[index - 1]!
		const current = posts[index]!
		if (previous.date === current.date) {
			expect(previous.order).toBeLessThanOrEqual(current.order)
		} else {
			expect(previous.date >= current.date).toBe(true)
		}
	}
})

test('getReadNextBlogPost follows catalog order and wraps to the first post', () => {
	const posts = listBlogPosts()
	expect(posts.length).toBeGreaterThan(1)
	expect(posts.map((post) => getReadNextBlogPost(post.slug))).toEqual(
		posts.map((_, index) => {
			const next = posts[(index + 1) % posts.length]!
			return { slug: next.slug, title: next.title }
		}),
	)
	expect(getReadNextBlogPost('does-not-exist')).toBeNull()
})

test('buildBlogRssXml escapes markup and includes every catalog post', () => {
	const posts = listBlogPosts()
	const xml = buildBlogRssXml({ origin: 'https://heykody.dev', posts })

	expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
	expect(xml).toContain('<rss version="2.0">')
	expect(xml).toContain('<link>https://heykody.dev/blog</link>')

	for (const post of posts) {
		expect(xml).toContain(`<link>https://heykody.dev/blog/${post.slug}</link>`)
		const escapedTitle = post.title
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&apos;')
		expect(xml).toContain(`<title>${escapedTitle}</title>`)
	}

	const escaped = buildBlogRssXml({
		origin: 'https://example.com',
		posts: [
			{
				slug: 'amp',
				title: 'A & B <C>',
				date: '2026-07-20',
				description: `Say "hi" & 'bye'`,
				order: 1,
				placeholder: true,
				image: null,
				imageAlt: null,
				ogImage: null,
				body: 'unused',
			},
		],
	})
	expect(escaped).toContain('A &amp; B &lt;C&gt;')
	expect(escaped).toContain('Say &quot;hi&quot; &amp; &apos;bye&apos;')
})
