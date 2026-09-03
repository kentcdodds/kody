import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'
import {
	getScrollRestorationInlineScript,
	getStoredScrollY,
	isRecordFocusInViewport,
	parseSavedScrollPositions,
	scrollRestorationInlineScriptCspHash,
	serializeSavedScrollPositions,
} from './router-scroll-restoration.ts'

test('sessionStorage scroll positions restore the saved Y for the current history key', () => {
	const stored = serializeSavedScrollPositions({
		'scroll-key-1': 2000,
		'scroll-key-2': 3400,
	})
	expect(JSON.parse(stored)).toEqual({
		'scroll-key-1': 2000,
		'scroll-key-2': 3400,
	})

	const positions = parseSavedScrollPositions(stored)
	expect(getStoredScrollY(positions, 'scroll-key-1')).toBe(2000)
	expect(getStoredScrollY(positions, 'scroll-key-2')).toBe(3400)
	expect(getStoredScrollY(positions, 'missing-key')).toBeNull()
	expect(getStoredScrollY(positions, null)).toBeNull()
	expect(parseSavedScrollPositions(null)).toEqual({})
	expect(parseSavedScrollPositions('[{"not":"rr-format"}]')).toEqual({})

	const restoreScript = getScrollRestorationInlineScript()
	expect(scrollRestorationInlineScriptCspHash).toBe(
		`'sha256-${createHash('sha256').update(restoreScript, 'utf8').digest('base64')}'`,
	)

	const scrollTo = vi.fn()
	const history = {
		scrollRestoration: 'auto',
		state: { key: 'scroll-key-1' },
		replaceState: vi.fn(),
	}
	const querySelector = vi.fn()
	runInNewContext(restoreScript, {
		window: { history, scrollTo, innerHeight: 800 },
		document: {
			querySelector,
			documentElement: { clientHeight: 800 },
		},
		sessionStorage: {
			getItem: () => stored,
			removeItem: vi.fn(),
		},
		console,
		Math,
	})
	expect(history.scrollRestoration).toBe('manual')
	expect(scrollTo).toHaveBeenCalledWith(0, 2000)
	expect(history.replaceState).not.toHaveBeenCalled()
	expect(querySelector).not.toHaveBeenCalled()
})

test('pre-hydration restore scrolls an off-screen list/detail record when no Y is saved', () => {
	const restoreScript = getScrollRestorationInlineScript()
	expect(restoreScript).toContain('[data-record-focus]')

	const scrollTo = vi.fn()
	const scrollIntoView = vi.fn()
	const history = {
		scrollRestoration: 'auto',
		state: { key: 'scroll-key-1' },
		replaceState: vi.fn(),
	}
	runInNewContext(restoreScript, {
		window: { history, scrollTo, innerHeight: 800 },
		document: {
			querySelector: (selector: string) => {
				expect(selector).toBe('[data-record-focus]')
				return {
					getBoundingClientRect: () => ({ top: 2400, bottom: 2480 }),
					scrollIntoView,
				}
			},
			documentElement: { clientHeight: 800 },
		},
		sessionStorage: {
			getItem: () => '{}',
			removeItem: vi.fn(),
		},
		console,
		Math,
	})
	expect(scrollTo).not.toHaveBeenCalled()
	expect(scrollIntoView).toHaveBeenCalledTimes(1)

	scrollIntoView.mockClear()
	runInNewContext(restoreScript, {
		window: { history, scrollTo, innerHeight: 800 },
		document: {
			querySelector: () => ({
				getBoundingClientRect: () => ({ top: 120, bottom: 160 }),
				scrollIntoView,
			}),
			documentElement: { clientHeight: 800 },
		},
		sessionStorage: {
			getItem: () => '{}',
			removeItem: vi.fn(),
		},
		console,
		Math,
	})
	expect(scrollIntoView).not.toHaveBeenCalled()
})

test('record focus is in the viewport only when it intersects the window', () => {
	expect(isRecordFocusInViewport({ top: 40, bottom: 80 }, 800)).toBe(true)
	expect(isRecordFocusInViewport({ top: -20, bottom: 40 }, 800)).toBe(true)
	expect(isRecordFocusInViewport({ top: 2400, bottom: 2480 }, 800)).toBe(false)
	expect(isRecordFocusInViewport({ top: -80, bottom: 0 }, 800)).toBe(false)
})
