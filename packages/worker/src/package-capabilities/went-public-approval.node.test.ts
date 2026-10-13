import { expect, test } from 'vitest'
import { readWentPublicSummary } from './went-public-approval.ts'

test('readWentPublicSummary prefers details.summary and has a default', () => {
	expect(readWentPublicSummary({ summary: ' Custom summary. ' })).toBe(
		'Custom summary.',
	)
	expect(readWentPublicSummary({})).toBe(
		'Serve this package on the public internet.',
	)
	expect(readWentPublicSummary({ summary: '   ' })).toBe(
		'Serve this package on the public internet.',
	)
})
