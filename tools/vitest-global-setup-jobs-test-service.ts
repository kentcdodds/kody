import { buildJobsTestService } from './build-jobs-test-service.ts'

/**
 * Vitest global setup for the workers-unit pool: builds the auxiliary
 * "kody-jobs-test" worker bundle that serves the main worker's JOBS service
 * binding (ADR 0016) inside the pool.
 */
export default async function setup() {
	await buildJobsTestService()
}
