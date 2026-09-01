import { expect, test } from 'vitest'
import {
	formatActiveRetiringPrimitivesInstructions,
	formatRetiringPrimitivesInstructions,
} from './retiring-primitives.ts'

test('retiring-primitives formatter omits the section when empty and names guides', () => {
	expect(formatRetiringPrimitivesInstructions([])).toBe('')
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
