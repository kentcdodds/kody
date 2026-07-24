import { expect, test, vi } from 'vitest'
import { installNavigationApiFallback } from './navigation-api-fallback.ts'

function createFakeWindow() {
	return {
		location: {
			href: 'https://heykody.dev/community',
			assign: vi.fn(),
			replace: vi.fn(),
		},
	} as unknown as Window
}

test('navigation fallback stands in for the Navigation API only when it is missing', () => {
	const win = createFakeWindow()

	expect(installNavigationApiFallback(win)).toBe(true)

	// The unguarded call that kills Remix hydration on browsers without the
	// Navigation API.
	const navigation = win.navigation
	navigation.updateCurrentEntry({
		state: { src: 'https://heykody.dev/community', $rmx: true },
	})
	expect(navigation.currentEntry?.getState()).toEqual({
		src: 'https://heykody.dev/community',
		$rmx: true,
	})
	expect(navigation.entries()).toHaveLength(1)

	// Remix subscribes to `navigate` with an abort signal; nothing ever
	// dispatches one, so link clicks stay with the browser.
	const listener = vi.fn()
	const controller = new AbortController()
	navigation.addEventListener('navigate', listener, {
		signal: controller.signal,
	})
	expect(listener).not.toHaveBeenCalled()

	navigation.navigate('/community/abc', { history: 'push' })
	expect(win.location.assign).toHaveBeenCalledWith(
		'https://heykody.dev/community/abc',
	)
	navigation.navigate('/login', { history: 'replace' })
	expect(win.location.replace).toHaveBeenCalledWith('https://heykody.dev/login')

	const browserWithNavigation = createFakeWindow()
	const realNavigation = {
		updateCurrentEntry: vi.fn(),
	} as unknown as Navigation
	browserWithNavigation.navigation = realNavigation

	expect(installNavigationApiFallback(browserWithNavigation)).toBe(false)
	expect(browserWithNavigation.navigation).toBe(realNavigation)
})
