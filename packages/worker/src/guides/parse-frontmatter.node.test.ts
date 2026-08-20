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

test('guide image frontmatter carries display and OG artwork', () => {
	expect(parseGuideMarkdown('illustrated-guide', guideBody)).toMatchObject({
		image: '/images/kody-factory-map.webp',
		imageAlt: 'Kody presenting a map of the software factory',
		ogImage: '/images/kody-factory-map-og.jpg',
	})
})

test('guide image frontmatter requires a safe asset path and alt text', () => {
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
