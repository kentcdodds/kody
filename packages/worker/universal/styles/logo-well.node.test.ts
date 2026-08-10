import { expect, test } from 'vitest'
import { getLogoWellCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

test('logo wells use a fixed white plate so marks stay readable in dark mode', () => {
	const well = getLogoWellCss({ size: '3.2rem', radius: '12px' })

	expect(well.backgroundColor).toBe('#ffffff')
	expect(well.backgroundColor).toBe(colors.logoWell)
	expect(well.color).toBe(colors.logoWellInk)
	expect(well.backgroundColor).not.toBe(colors.surface)
	expect(well.backgroundColor).not.toBe(colors.background)
})
