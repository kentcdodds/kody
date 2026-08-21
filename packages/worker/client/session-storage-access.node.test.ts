import { afterEach, expect, test } from 'vitest'
import {
	getSessionStorageItem,
	setSessionStorageItem,
} from './session-storage-access.ts'

const originalDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

afterEach(() => {
	if (originalDescriptor) {
		Object.defineProperty(globalThis, 'sessionStorage', originalDescriptor)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
})

function installThrowingSessionStorage() {
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		enumerable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})
}

test('getSessionStorageItem returns null when sessionStorage access throws SecurityError', () => {
	installThrowingSessionStorage()
	expect(getSessionStorageItem('kody:router-scroll-positions')).toBeNull()
})

test('setSessionStorageItem returns false when sessionStorage access throws SecurityError', () => {
	installThrowingSessionStorage()
	expect(setSessionStorageItem('kody:router-scroll-positions', '{}')).toBe(
		false,
	)
})

test('getSessionStorageItem and setSessionStorageItem round-trip when storage works', () => {
	const store = new Map<string, string>()
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		enumerable: true,
		value: {
			getItem(key: string) {
				return store.get(key) ?? null
			},
			setItem(key: string, value: string) {
				store.set(key, value)
			},
		},
	})

	expect(setSessionStorageItem('kody:test', '{"a":1}')).toBe(true)
	expect(getSessionStorageItem('kody:test')).toBe('{"a":1}')
})
