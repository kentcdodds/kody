import { expect, test } from 'vitest'
import { readWentPublicSummary } from './went-public-approval.ts'

test('readWentPublicSummary trims a provided summary', () => {
	expect(readWentPublicSummary({ summary: ' Custom summary. ' })).toBe(
		'Custom summary.',
	)
})
