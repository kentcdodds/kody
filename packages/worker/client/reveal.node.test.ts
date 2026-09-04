import { expect, test } from 'vitest'
import { revealTargetIsInView } from './reveal.ts'

test('revealTargetIsInView treats above-the-fold boxes as already visible', () => {
	expect(revealTargetIsInView({ top: 80, bottom: 240 }, 800)).toBe(true)
	expect(revealTargetIsInView({ top: 0, bottom: 40 }, 800)).toBe(true)
	expect(revealTargetIsInView({ top: 760, bottom: 900 }, 800)).toBe(true)
	expect(revealTargetIsInView({ top: 801, bottom: 960 }, 800)).toBe(false)
	expect(revealTargetIsInView({ top: -80, bottom: -10 }, 800)).toBe(false)
})
