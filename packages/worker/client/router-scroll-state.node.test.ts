import { expect, test } from 'vitest'
import {
	createScrollRestorationHistoryState,
	getScrollRestorationKey,
	getScrollRestorationTarget,
} from './router-scroll-state.ts'

test('scroll restoration history state preserves existing state values', () => {
	const state = createScrollRestorationHistoryState(
		{ userState: 'kept' },
		'scroll-key-1',
	)

	expect(state).toEqual({
		kodyScrollRestorationKey: 'scroll-key-1',
		userState: 'kept',
	})
	expect(getScrollRestorationKey(state)).toBe('scroll-key-1')
})

test('push navigations scroll to the top by default', () => {
	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/account/secrets',
		}),
	).toEqual({ type: 'top' })
})

test('preventScrollReset preserves push navigation scroll without a hash', () => {
	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/account/secrets',
			preventScrollReset: true,
		}),
	).toEqual({ type: 'preserve' })
})

test('hash targets take precedence over preventScrollReset', () => {
	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/community/package#readme%20section',
			preventScrollReset: true,
		}),
	).toEqual({ type: 'hash', id: 'readme section' })
})

test('pop navigations restore saved positions before hash scrolling', () => {
	expect(
		getScrollRestorationTarget({
			historyAction: 'pop',
			location: '/community#listing',
			savedPosition: { x: 12, y: 340 },
		}),
	).toEqual({ type: 'position', position: { x: 12, y: 340 } })
})

test('pop navigations without a saved position fall back to the normal reset rules', () => {
	expect(
		getScrollRestorationTarget({
			historyAction: 'pop',
			location: '/community',
		}),
	).toEqual({ type: 'top' })
})
