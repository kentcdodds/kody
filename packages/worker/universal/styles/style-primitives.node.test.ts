import { expect, test } from 'vitest'
import {
	getArticleBreakoutCss,
	getAuthInputCss,
	getSelectCss,
	inputCss,
	layoutMaxWidths,
	packageDetailPageCss,
} from './style-primitives.ts'
import { colors } from './tokens.ts'

test('text input and select primitives use the field-border token', () => {
	expect(inputCss.border).toBe(`1px solid ${colors.fieldBorder}`)
	expect(getAuthInputCss().border).toBe(`1.5px solid ${colors.fieldBorder}`)
	expect(getSelectCss().border).toBe(`1.5px solid ${colors.fieldBorder}`)
	expect(inputCss.border).not.toBe(`1px solid ${colors.border}`)
})

test('article breakout is viewport-centered and must not be used under the docs sidebar', () => {
	const breakout = getArticleBreakoutCss()
	expect(breakout.width).toContain('100vw')
	expect(breakout.marginInline).toContain('50vw')
	expect(breakout.maxWidth).toBe('none')
})

test('package detail tabs share the extended page box and patterned background', () => {
	expect(packageDetailPageCss.maxWidth).toBe(layoutMaxWidths.extended)
	// Content-box like the site header — border-box would shrink Files by
	// two pageGutters inside maxWidth.
	expect(
		'boxSizing' in packageDetailPageCss
			? packageDetailPageCss.boxSizing
			: undefined,
	).toBe(undefined)
	expect(packageDetailPageCss['&::before']?.maskImage).toBe(
		'var(--kody-pattern)',
	)
})
