import { expect, test } from 'vitest'
import {
	formatRetiringPrimitivesInstructions,
	retiringPrimitiveNotices,
} from './retiring-primitives.ts'

test('formatRetiringPrimitivesInstructions omits an empty registry', () => {
	expect(formatRetiringPrimitivesInstructions([])).toBe('')
})

test('formatRetiringPrimitivesInstructions lists each notice with its guide', () => {
	const section = formatRetiringPrimitivesInstructions([
		{
			label: 'Example',
			guide: 'example_guide',
			summary: 'Do not write new rows.',
		},
	])
	expect(section).toBe(
		'Retiring primitives\n- Example: Do not write new rows. Load `coding_guide_get({ guide: "example_guide" })` to migrate.',
	)
})

test('values retirement is registered with a loadable guide id', () => {
	expect(retiringPrimitiveNotices).toEqual([
		{
			label: 'Values',
			guide: 'values',
			summary:
				'Do not write new `value_set` rows. Existing names stay readable.',
		},
	])
	expect(formatRetiringPrimitivesInstructions()).toContain(
		'coding_guide_get({ guide: "values" })',
	)
})
