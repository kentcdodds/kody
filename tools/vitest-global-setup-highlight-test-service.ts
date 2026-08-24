import { buildHighlightTestService } from './build-highlight-test-service.ts'

/**
 * Vitest global setup for the workers-unit pool: builds the auxiliary
 * "kody-highlight-test" worker bundle that serves the main worker's
 * HIGHLIGHT service binding inside the pool.
 */
export default async function setup() {
	await buildHighlightTestService()
}
