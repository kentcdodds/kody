import { expect, test } from 'vitest'
import { parseGuideMarkdown } from './parse-frontmatter.ts'

const guideBody = `---
id: illustrated_guide
title: Illustrated guide
summary: A guide with artwork.
category: platform
image: /images/kody-factory-map.webp
imageAlt: Kody presenting a map of the software factory
ogImage: /images/kody-factory-map-og.jpg
---

# Illustrated guide

Body copy.
`

test('guide image frontmatter carries display and OG artwork with safe paths', () => {
	expect(parseGuideMarkdown('illustrated-guide', guideBody)).toMatchObject({
		image: '/images/kody-factory-map.webp',
		imageAlt: 'Kody presenting a map of the software factory',
		ogImage: '/images/kody-factory-map-og.jpg',
		adminOnly: false,
	})

	expect(() =>
		parseGuideMarkdown(
			'illustrated-guide',
			guideBody.replace(
				'image: /images/kody-factory-map.webp',
				'image: https://example.com/image.webp',
			),
		),
	).toThrow(/invalid frontmatter "image"/)

	expect(() =>
		parseGuideMarkdown(
			'illustrated-guide',
			guideBody.replace(
				'imageAlt: Kody presenting a map of the software factory\n',
				'',
			),
		),
	).toThrow(/missing frontmatter "imageAlt"/)
})

test('adminOnly frontmatter is opt-in and cannot combine with unadvertised', () => {
	expect(
		parseGuideMarkdown(
			'admin-events',
			guideBody.replace(
				'category: platform\n',
				'category: platform\nadminOnly: true\n',
			),
		).adminOnly,
	).toBe(true)

	expect(() =>
		parseGuideMarkdown(
			'admin-events',
			guideBody.replace(
				'category: platform\n',
				'category: platform\nadminOnly: maybe\n',
			),
		),
	).toThrow(/invalid frontmatter "adminOnly"/)

	expect(() =>
		parseGuideMarkdown(
			'admin-events',
			guideBody.replace(
				'category: platform\n',
				'category: platform\nunadvertised: true\nadminOnly: true\n',
			),
		),
	).toThrow(/cannot set both frontmatter "unadvertised" and "adminOnly"/)
})
