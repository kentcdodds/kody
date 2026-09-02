import { expect, test } from 'vitest'
import { colors } from './tokens.ts'

test('fieldBorder is a dedicated token, not the decorative divider', () => {
	expect(colors.fieldBorder).toBe('var(--color-field-border)')
	expect(colors.border).toBe('var(--color-border)')
	expect(colors.fieldBorder).not.toBe(colors.border)
})
