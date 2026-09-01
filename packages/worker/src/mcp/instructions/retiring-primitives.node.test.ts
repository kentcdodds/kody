import { expect, test } from 'vitest'
import {
	formatActiveRetiringPrimitivesInstructions,
	formatRetiringPrimitivesInstructions,
	loadActiveRetiringNoticeIds,
	retiringPrimitiveNotices,
} from './retiring-primitives.ts'

test('retiring-primitives registry is empty and omits the instruction section', async () => {
	expect(retiringPrimitiveNotices).toEqual([])
	await expect(
		loadActiveRetiringNoticeIds({} as D1Database, 'user-1'),
	).resolves.toEqual(new Set())
	expect(formatActiveRetiringPrimitivesInstructions(new Set())).toBe('')

	const formatted = formatRetiringPrimitivesInstructions([
		{
			label: 'Example',
			guide: 'example',
			summary: 'One-line rule.',
		},
	])
	expect(formatted.startsWith('Retiring primitives')).toBe(true)
	expect(formatted).toContain('Example:')
	expect(formatted).toContain('example:guide')
	expect(formatted).toContain('"example:guide"')
})
