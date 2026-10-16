import { afterEach, expect, test, vi } from 'vitest'
import {
	clearUnknownStartReleaseReloadFlag,
	reloadOnUnknownStartRelease,
	unknownStartReleaseReloadFlag,
} from './reload-on-unknown-start-release.ts'

const originalWindow = globalThis.window
const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreGlobals() {
	globalThis.window = originalWindow
	if (originalSessionStorage) {
		Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
}

afterEach(() => {
	restoreGlobals()
	vi.restoreAllMocks()
})

function installSessionStorage(store: Map<string, string>) {
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem(key: string) {
				return store.has(key) ? store.get(key)! : null
			},
			setItem(key: string, value: string) {
				store.set(key, value)
			},
			removeItem(key: string) {
				store.delete(key)
			},
		},
	})
}

function installWindow(reload: () => void) {
	globalThis.window = {
		location: { reload },
	} as unknown as Window & typeof globalThis
}

test('reloadOnUnknownStartRelease reloads once for Unknown Start release errors', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)

	expect(reloadOnUnknownStartRelease(new Error('Unknown Start release.'))).toBe(
		true,
	)
	expect(reload).toHaveBeenCalledTimes(1)
	expect(store.get(unknownStartReleaseReloadFlag)).toBe('1')

	expect(
		reloadOnUnknownStartRelease(new Error('Error: Unknown Start release.')),
	).toBe(false)
	expect(reload).toHaveBeenCalledTimes(1)
})

test('clearUnknownStartReleaseReloadFlag allows a later deploy to recover again', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)

	expect(reloadOnUnknownStartRelease(new Error('Unknown Start release.'))).toBe(
		true,
	)
	expect(reload).toHaveBeenCalledTimes(1)

	clearUnknownStartReleaseReloadFlag()
	expect(store.has(unknownStartReleaseReloadFlag)).toBe(false)

	expect(reloadOnUnknownStartRelease(new Error('Unknown Start release.'))).toBe(
		true,
	)
	expect(reload).toHaveBeenCalledTimes(2)
	expect(store.get(unknownStartReleaseReloadFlag)).toBe('1')
})

test('clearUnknownStartReleaseReloadFlag does not throw when sessionStorage is unavailable', () => {
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})

	expect(() => clearUnknownStartReleaseReloadFlag()).not.toThrow()
})

test('reloadOnUnknownStartRelease ignores near-miss messages', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)

	expect(reloadOnUnknownStartRelease(new Error('Unknown Start build.'))).toBe(
		false,
	)
	expect(reloadOnUnknownStartRelease('Unknown Start release hash.')).toBe(false)
	expect(reload).not.toHaveBeenCalled()
	expect(store.has(unknownStartReleaseReloadFlag)).toBe(false)
})

test('reloadOnUnknownStartRelease does not throw or reload when sessionStorage is unavailable', () => {
	const reload = vi.fn()
	installWindow(reload)
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})

	expect(() =>
		reloadOnUnknownStartRelease(new Error('Unknown Start release.')),
	).not.toThrow()
	expect(reload).not.toHaveBeenCalled()
})

test('reloadOnUnknownStartRelease accepts Sentry event.message strings', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)

	// beforeSend falls back to event.message / exception value when
	// originalException is absent.
	expect(reloadOnUnknownStartRelease('Unknown Start release.')).toBe(true)
	expect(reload).toHaveBeenCalledTimes(1)
})
