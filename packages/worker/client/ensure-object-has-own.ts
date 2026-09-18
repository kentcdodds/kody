/**
 * Remix UI's `copyOwnRmxEntries` (frame runtime) calls `Object.hasOwn`.
 * That is ES2022; Whale 4.34 and similar Chromium forks omit it and abort
 * client hydration with `TypeError: Object.hasOwn is not a function`
 * (KODY-7R). Install the standard `hasOwnProperty` polyfill before `run()`
 * when needed.
 */
type ObjectHasOwnHost = {
	hasOwn?: (object: object, property: PropertyKey) => boolean
}

export function ensureObjectHasOwn(
	objectCtor: ObjectHasOwnHost | undefined = Object,
): void {
	if (!objectCtor) return
	if (typeof objectCtor.hasOwn === 'function') return

	const polyfill = function hasOwn(
		object: object,
		property: PropertyKey,
	): boolean {
		return Object.prototype.hasOwnProperty.call(object, property)
	}

	try {
		Object.defineProperty(objectCtor, 'hasOwn', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: polyfill,
		})
	} catch {
		try {
			objectCtor.hasOwn = polyfill
		} catch {
			// Leave Object unchanged; Remix will still throw if it calls hasOwn.
		}
	}
}
