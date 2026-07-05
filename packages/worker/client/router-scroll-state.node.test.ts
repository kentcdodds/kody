import { expect, test } from 'vitest'
import {
	createScrollRestorationHistoryState,
	getScrollRestorationKey,
	getScrollRestorationTarget,
} from './router-scroll-state.ts'

test('scroll restoration history state and navigation targets follow push, pop, hash, and preserve rules', () => {
	const state = createScrollRestorationHistoryState(
		{ userState: 'kept' },
		'scroll-key-1',
	)
	expect(state).toEqual({
		kodyScrollRestorationKey: 'scroll-key-1',
		userState: 'kept',
	})
	expect(getScrollRestorationKey(state)).toBe('scroll-key-1')

	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/account/secrets',
		}),
	).toEqual({ type: 'top' })
	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/account/secrets',
			preventScrollReset: true,
		}),
	).toEqual({ type: 'preserve' })
	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/community/package#readme%20section',
			preventScrollReset: true,
		}),
	).toEqual({ type: 'hash', id: 'readme section' })
	expect(
		getScrollRestorationTarget({
			historyAction: 'pop',
			location: '/community#listing',
			savedPosition: { x: 12, y: 340 },
		}),
	).toEqual({ type: 'position', position: { x: 12, y: 340 } })
	expect(
		getScrollRestorationTarget({
			historyAction: 'pop',
			location: '/community',
		}),
	).toEqual({ type: 'top' })
})
