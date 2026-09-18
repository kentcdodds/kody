/**
 * `Object.hasOwn` was introduced in ES2022 (Chrome 93, Firefox 92, Safari 15.4).
 * Older Chromium-based browsers such as Whale 4.34.340 do not implement it.
 * `@remix-run/ui`'s frame runtime calls `Object.hasOwn` during hydration startup,
 * so we must polyfill it before calling `run()`.
 */
export function ensureObjectHasOwn(): void {
	if (typeof Object.hasOwn === 'function') return

	Object.defineProperty(Object, 'hasOwn', {
		configurable: true,
		enumerable: false,
		writable: true,
		value: function hasOwn(obj: object, prop: PropertyKey): boolean {
			return Object.prototype.hasOwnProperty.call(obj, prop)
		},
	})
}
