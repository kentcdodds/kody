import { expect, test } from 'vitest'
import {
	getBlogPost,
	getReadNextBlogPost,
	listBlogPosts,
	toBlogPostSummary,
} from './catalog.ts'
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
		placeholder: true,
		image: null,
		imageAlt: null,
		ogImage: null,
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

	const reviewed = parseBlogPostMarkdown(
		'reviewed',
		`---
title: Reviewed
date: 2026-08-20
description: A reviewed post.
order: 1
placeholder: false
image: /images/kody-vs-executor.webp
imageAlt: Kody and the Executor logo size each other up.
---

Body
`,
	)
	expect(reviewed).toMatchObject({
		placeholder: false,
		image: '/images/kody-vs-executor.webp',
		imageAlt: 'Kody and the Executor logo size each other up.',
		ogImage: null,
	})

	const customOg = parseBlogPostMarkdown(
		'custom-og',
		`---
title: Custom OG
date: 2026-08-20
description: A post with a static social image.
order: 1
image: /images/kody-vs-executor.webp
imageAlt: Headline art.
ogImage: /images/kody-vs-executor.webp
---

Body
`,
	)
	expect(customOg.ogImage).toBe('/images/kody-vs-executor.webp')

	expect(() =>
		parseBlogPostMarkdown(
			'bad-placeholder',
			`---
title: Bad placeholder
date: 2026-08-20
description: Nope
order: 1
placeholder: maybe
---

Body
`,
		),
	).toThrow(/invalid frontmatter "placeholder"/)

	expect(() =>
		parseBlogPostMarkdown(
			'bad-image',
			`---
title: Bad image
date: 2026-08-20
description: Nope
order: 1
image: https://example.com/image.webp
imageAlt: Nope
---

Body
`,
		),
	).toThrow(/invalid frontmatter "image"/)
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

	const comparison = getBlogPost('kody-vs-executor')
	expect(comparison?.title).toBe('Kody vs Executor?')
	expect(comparison?.date).toBe('2026-08-20')
	expect(comparison?.placeholder).toBe(false)
	expect(comparison?.image).toBe('/images/kody-vs-executor.webp')
	expect(comparison?.ogImage).toBe('/images/kody-vs-executor-og.jpg')
	const comparisonBody = (comparison?.body ?? '').replace(/\s+/g, ' ')
	expect(comparisonBody).toContain('best of both worlds')
	expect(comparisonBody).toContain('Leave one `execute`')
	expect(comparisonBody).toContain(
		'I wrote this on August 20, 2026. Both products will keep moving. The comparison is accurate as of that date.',
	)
	expect(getBlogPost('does-not-exist')).toBeNull()

	const placeholderPosts = posts.filter(
		(post) => post.slug !== 'kody-vs-executor',
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

	for (let index = 0; index < posts.length; index += 1) {
		const current = posts[index]!
		const expected = posts[(index + 1) % posts.length]!
		expect(getReadNextBlogPost(current.slug)).toEqual({
			slug: expected.slug,
			title: expected.title,
		})
	}

	expect(getReadNextBlogPost('does-not-exist')).toBeNull()
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
