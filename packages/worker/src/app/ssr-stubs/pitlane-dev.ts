import { type Handle } from 'remix/ui'

/**
 * Vitest alias target for `pitlane:dev` if a test graph still imports that
 * specifier. SSR itself uses `#app/hmr.ts` (no-op in Wrangler/Vitest, Pitlane
 * `HMR` under Vite).
 */
export function HMR(_handle: Handle) {
	return () => null
}
