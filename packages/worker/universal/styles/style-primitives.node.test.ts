import { expect, test } from 'vitest'
import { getAuthInputCss, getSelectCss, inputCss } from './style-primitives.ts'
import { colors } from './tokens.ts'

test('text input and select primitives use the field-border token', () => {
	expect(inputCss.border).toBe(`1px solid ${colors.fieldBorder}`)
	expect(getAuthInputCss().border).toBe(`1.5px solid ${colors.fieldBorder}`)
	expect(getSelectCss().border).toBe(`1.5px solid ${colors.fieldBorder}`)
	expect(inputCss.border).not.toBe(`1px solid ${colors.border}`)
})
