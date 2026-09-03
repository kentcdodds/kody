import { readMainWorkerWranglerCompatibility } from './wrangler-compatibility.ts'

/**
 * Node-unit setup: workerd exposes the active compatibility flags on the
 * `Cloudflare` global, and `@cloudflare/workers-oauth-provider` reads
 * `Cloudflare.compatibilityFlags.global_fetch_strictly_public` at module load
 * (warning through `console.warn`, which the console spies turn into a test
 * failure, when it is off). Mirror the flags the worker actually deploys with
 * so node tests that lazily load the provider see the same environment.
 */
const compatibilityFlags = Object.fromEntries(
	readMainWorkerWranglerCompatibility().compatibilityFlags.map((flag) => [
		flag,
		true,
	]),
)

Object.defineProperty(globalThis, 'Cloudflare', {
	value: { compatibilityFlags },
	configurable: true,
	writable: true,
})
