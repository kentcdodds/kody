import { expect, test } from 'vitest'
import { truncateOgText } from './render.ts'

test('truncateOgText leaves text under the budget alone and collapses whitespace', () => {
	expect(truncateOgText('  Kody   the koala ', 40)).toBe('Kody the koala')
})

test('truncateOgText breaks on a word boundary rather than mid-word', () => {
	const excerpt =
		'Those things should live somewhere durable that you own, no matter which host'
	// Ends on a whole word, and the dangling comma goes with it. The old
	// character-count cut produced "…that you own, no m…".
	expect(truncateOgText(excerpt, 60)).toBe(
		'Those things should live somewhere durable that you own…',
	)
})

test('truncateOgText falls back to a hard cut when one word fills the budget', () => {
	const result = truncateOgText('supercalifragilisticexpialidocious tail', 12)
	expect(result).toBe('supercalifr…')
})
