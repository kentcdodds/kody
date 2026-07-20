import { expect, test } from 'vitest'
import { getBlogPost, listBlogPosts, toBlogPostSummary } from './catalog.ts'
import { parseBlogPostMarkdown } from './parse-frontmatter.ts'
import { buildBlogRssXml } from './rss.ts'

test('parseBlogPostMarkdown reads frontmatter and rejects invalid input', () => {
	const post = parseBlogPostMarkdown(
		'sample',
		`---
title: Sample title
date: 2026-07-18
description: A short description for meta tags.
order: 3
---

# Hello

Body paragraph.
`,
	)
	expect(post).toEqual({
		slug: 'sample',
		title: 'Sample title',
		date: '2026-07-18',
		description: 'A short description for meta tags.',
		order: 3,
		body: '# Hello\n\nBody paragraph.\n',
	})

	const multiline = parseBlogPostMarkdown(
		'multiline',
		`---
title: Multiline
date: 2026-07-19
description:
  First sentence about the post.
  Second sentence for meta tags.
order: 2
---

Body
`,
	)
	expect(multiline.description).toBe(
		'First sentence about the post. Second sentence for meta tags.',
	)

	expect(() =>
		parseBlogPostMarkdown(
			'bad-date',
			`---
title: Bad date
date: 07/20/2026
description: Nope
order: 1
---

Body
`,
		),
	).toThrow(/invalid frontmatter "date"/)

	expect(() =>
		parseBlogPostMarkdown(
			'missing-title',
			`---
date: 2026-07-20
description: Nope
order: 1
---

Body
`,
		),
	).toThrow(/missing frontmatter "title"/)
})

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
		expect(toBlogPostSummary(post)).toEqual({
			slug: post.slug,
			title: post.title,
			date: post.date,
			description: post.description,
			order: post.order,
		})
	}

	expect(getBlogPost('does-not-exist')).toBeNull()

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

test('buildBlogRssXml escapes markup and includes every catalog post', () => {
	const posts = listBlogPosts()
	const xml = buildBlogRssXml({
		origin: 'https://heykody.dev',
		posts,
	})

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
				body: 'unused',
			},
		],
	})
	expect(escaped).toContain('A &amp; B &lt;C&gt;')
	expect(escaped).toContain('Say &quot;hi&quot; &amp; &apos;bye&apos;')
})
