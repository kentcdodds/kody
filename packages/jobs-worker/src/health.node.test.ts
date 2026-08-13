import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	collectJobsHealthComponents,
	handleJobsHealthRequest,
} from './health.ts'

function healthyDb() {
	return {
		prepare: () => ({ first: async () => ({ 1: 1 }) }),
	} as unknown as D1Database
}

test('jobs health reports liveness and treats JOBS_DB failure as components-down', async () => {
	const liveness = await handleJobsHealthRequest(
		new Request('https://kody-jobs.example/health'),
		{ APP_COMMIT_SHA: 'abc123def456' },
	)
	expect(liveness?.status).toBe(200)
	await expect(liveness?.json()).resolves.toEqual({
		ok: true,
		commit: 'abc123def456',
	})

	const healthy = await collectJobsHealthComponents({
		APP_COMMIT_SHA: 'abc123def456',
		JOBS_DB: healthyDb(),
	})
	expect(healthy.ok).toBe(true)
	expect(healthy.commit).toBe('abc123def456')
	expect(healthy.components).toEqual([
		expect.objectContaining({ id: 'jobs_db', ok: true }),
	])

	const healthyResponse = await handleJobsHealthRequest(
		new Request('https://kody-jobs.example/health/components'),
		{ APP_COMMIT_SHA: 'abc123def456', JOBS_DB: healthyDb() },
	)
	expect(healthyResponse?.status).toBe(200)
	await expect(healthyResponse?.json()).resolves.toMatchObject({
		ok: true,
		commit: 'abc123def456',
		components: [expect.objectContaining({ id: 'jobs_db', ok: true })],
	})

	consoleWarn.mockImplementation(() => {})
	const failedResponse = await handleJobsHealthRequest(
		new Request('https://kody-jobs.example/health/components'),
		{
			APP_COMMIT_SHA: 'abc123def456',
			JOBS_DB: {
				prepare: () => ({
					first: async () => {
						throw new Error('database is unavailable')
					},
				}),
			} as unknown as D1Database,
		},
	)
	expect(failedResponse?.status).toBe(503)
	await expect(failedResponse?.json()).resolves.toMatchObject({
		ok: false,
		components: [
			expect.objectContaining({ id: 'jobs_db', ok: false, error: 'error' }),
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'jobs-health-component-failed',
		expect.any(String),
	)

	const missing = await collectJobsHealthComponents({
		APP_COMMIT_SHA: undefined,
	})
	expect(missing.ok).toBe(false)
	expect(missing.commit).toBeNull()
	expect(missing.components[0]).toMatchObject({
		id: 'jobs_db',
		ok: false,
		error: 'unavailable',
	})

	expect(
		await handleJobsHealthRequest(
			new Request('https://kody-jobs.example/other'),
			{ JOBS_DB: healthyDb() },
		),
	).toBeNull()
})
