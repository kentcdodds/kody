import { expect, test } from 'vitest'
import { truncateOgText } from './render.ts'

test('truncateOgText collapses whitespace, breaks on word boundaries, and hard-cuts long words', () => {
	expect(truncateOgText('  Kody   the koala ', 40)).toBe('Kody the koala')

	const excerpt =
		'Those things should live somewhere durable that you own, no matter which host'
	// Ends on a whole word, and the dangling comma goes with it. The old
	// character-count cut produced "…that you own, no m…".
	expect(truncateOgText(excerpt, 60)).toBe(
		'Those things should live somewhere durable that you own…',
	)

	expect(truncateOgText('supercalifragilisticexpialidocious tail', 12)).toBe(
		'supercalifr…',
	)
})
