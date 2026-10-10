import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { platformFeedbackCategories } from './types.ts'

const adminEventsGuidePath = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../docs/guides/admin-events.md',
)

/**
 * Pull the `category:` string-literal union from the
 * `PlatformFeedbackSubmittedEvent` TypeScript example in admin-events.md.
 * Keep that example aligned with `platformFeedbackCategories`.
 */
function extractDocumentedPlatformFeedbackCategories(markdown: string) {
	const eventBlock = markdown.match(
		/type PlatformFeedbackSubmittedEvent = \{[\s\S]*?\n\}/,
	)?.[0]
	if (!eventBlock) {
		throw new Error(
			'admin-events.md is missing the PlatformFeedbackSubmittedEvent type example.',
		)
	}
	const categoryBlock = eventBlock.match(
		/category:\s*((?:\|?\s*'[^']+'\s*)+)/,
	)?.[1]
	if (!categoryBlock) {
		throw new Error(
			'PlatformFeedbackSubmittedEvent example is missing a category union.',
		)
	}
	const categories = [...categoryBlock.matchAll(/'([^']+)'/g)].map(
		(match) => match[1]!,
	)
	if (categories.length === 0) {
		throw new Error(
			'PlatformFeedbackSubmittedEvent category union listed no literals.',
		)
	}
	return categories
}

test('admin-events guide lists every platformFeedbackCategories value', () => {
	const markdown = readFileSync(adminEventsGuidePath, 'utf8')
	expect(extractDocumentedPlatformFeedbackCategories(markdown)).toEqual([
		...platformFeedbackCategories,
	])
})
