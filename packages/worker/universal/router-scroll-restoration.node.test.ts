import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'
import {
	getScrollRestorationInlineScript,
	getStoredScrollY,
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
	runInNewContext(restoreScript, {
		window: { history, scrollTo },
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
})
