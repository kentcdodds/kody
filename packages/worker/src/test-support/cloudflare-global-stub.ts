/**
 * Node-unit setup: workerd exposes the active compatibility flags on the
 * `Cloudflare` global, and `@cloudflare/workers-oauth-provider` reads
 * `Cloudflare.compatibilityFlags.global_fetch_strictly_public` at module load
 * (warning through `console.warn`, which the console spies turn into a test
 * failure, when it is off). The flag is set in `packages/worker/wrangler.jsonc`;
 * `oauth-helpers.node.test.ts` asserts that so this stub cannot drift.
 *
 * Deliberately import-free: setup files run before a test file's hoisted
 * `vi.mock` calls, so any module loaded here (for example
 * `tools/ci/resource-utils.ts`, which imports `node:child_process`) is cached
 * with its real dependencies and escapes the test's mocks.
 */
Object.defineProperty(globalThis, 'Cloudflare', {
	value: { compatibilityFlags: { global_fetch_strictly_public: true } },
	configurable: true,
	writable: true,
})
