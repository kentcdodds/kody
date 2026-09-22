import { expect, test } from 'vitest'
import { parseOgEmphasis, stripOgEmphasis } from './og-emphasis.ts'

test('parseOgEmphasis splits balanced markers and keeps unbalanced text literal', () => {
	expect(parseOgEmphasis('Don\u2019t **start over** with every agent')).toEqual(
		[
			{ text: 'Don\u2019t ', emphasis: false },
			{ text: 'start over', emphasis: true },
			{ text: ' with every agent', emphasis: false },
		],
	)
	expect(parseOgEmphasis('**Switch** agents. **Keep** the work.')).toEqual([
		{ text: 'Switch', emphasis: true },
		{ text: ' agents. ', emphasis: false },
		{ text: 'Keep', emphasis: true },
		{ text: ' the work.', emphasis: false },
	])
	expect(parseOgEmphasis('no markers')).toEqual([
		{ text: 'no markers', emphasis: false },
	])
	expect(parseOgEmphasis('odd ** marker')).toEqual([
		{ text: 'odd ** marker', emphasis: false },
	])
	expect(parseOgEmphasis('')).toEqual([])
})

test('stripOgEmphasis drops markers and collapses hard line breaks', () => {
	expect(stripOgEmphasis('Don\u2019t **start over**\nwith every agent')).toBe(
		'Don\u2019t start over with every agent',
	)
	expect(
		stripOgEmphasis('The **software**\n**platform** your\nagents share'),
	).toBe('The software platform your agents share')
	expect(stripOgEmphasis('odd ** marker')).toBe('odd ** marker')
	expect(stripOgEmphasis('Good **copy**\nstray **')).toBe('Good copy stray **')
})
