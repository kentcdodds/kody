import { expect, test } from 'vitest'
import {
	createScrollRestorationHistoryState,
	getScrollRestorationKey,
	getScrollRestorationTarget,
	nextSavedScrollPosition,
} from './router-scroll-state.ts'

test('scroll restoration history state and navigation targets follow push, pop, hash, preserve, and load rules', () => {
	const state = createScrollRestorationHistoryState(
		{ userState: 'kept' },
		'scroll-key-1',
	)
	expect(state).toEqual({
		key: 'scroll-key-1',
		userState: 'kept',
	})
	expect(getScrollRestorationKey(state)).toBe('scroll-key-1')

	expect(
		getScrollRestorationTarget({
			historyAction: 'push',
			location: '/account/secrets',
		}),
	).toEqual({ type: 'record-focus' })
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
	).toEqual({ type: 'record-focus' })
	expect(
		getScrollRestorationTarget({
			historyAction: 'load',
			location: '/',
			savedPosition: { x: 0, y: 2000 },
		}),
	).toEqual({ type: 'position', position: { x: 0, y: 2000 } })
	expect(
		getScrollRestorationTarget({
			historyAction: 'load',
			location: '/',
		}),
	).toEqual({ type: 'record-focus' })
	expect(
		getScrollRestorationTarget({
			historyAction: 'load',
			location: '/#invite',
		}),
	).toEqual({ type: 'hash', id: 'invite' })
	expect(
		getScrollRestorationTarget({
			historyAction: 'load',
			location: '/admin/users/abc',
		}),
	).toEqual({ type: 'record-focus' })
})

test('a clamped scroll does not replace a saved Y the document cannot reach yet', () => {
	const saved = { x: 0, y: 3400 }

	expect(
		nextSavedScrollPosition(saved, { x: 0, y: 1200 }, { x: 0, y: 1200 }),
	).toEqual(saved)
	expect(
		nextSavedScrollPosition(saved, { x: 0, y: 0 }, { x: 0, y: 0 }),
	).toEqual(saved)
	expect(
		nextSavedScrollPosition(saved, { x: 0, y: 1199.4 }, { x: 0, y: 1200 }),
	).toEqual(saved)

	expect(
		nextSavedScrollPosition(saved, { x: 0, y: 800 }, { x: 0, y: 1200 }),
	).toEqual({ x: 0, y: 800 })
	expect(
		nextSavedScrollPosition(saved, { x: 0, y: 100 }, { x: 0, y: 5000 }),
	).toEqual({ x: 0, y: 100 })
	expect(
		nextSavedScrollPosition(saved, { x: 0, y: 3400 }, { x: 0, y: 5000 }),
	).toEqual({ x: 0, y: 3400 })
	expect(
		nextSavedScrollPosition(undefined, { x: 0, y: 1200 }, { x: 0, y: 1200 }),
	).toEqual({ x: 0, y: 1200 })
})
