import { type Handle } from 'remix/ui'

/**
 * Default HMR island for Wrangler-bundled tests and any non-Vite graph.
 * Vite aliases this module to `hmr.vite.ts`, which re-exports Pitlane's
 * `HMR` from `pitlane:dev`.
 */
export function HMR(_handle: Handle) {
	return () => null
}
