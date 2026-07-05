import { expect, test, vi } from 'vitest'

import { postDeployCapabilityReindex } from './post-deploy-capability-reindex.ts'

function createLogger() {
	return {
		log: vi.fn(),
		warn: vi.fn(),
	}
}

test('postDeployCapabilityReindex skips when the secret is missing', async () => {
	const logger = createLogger()
	const fetchImplementation = vi.fn<typeof fetch>()

	await expect(
		postDeployCapabilityReindex({
			env: {
				DEPLOY_URL: 'https://kody.example.com',
			},
			fetch: fetchImplementation,
			logger,
		}),
	).resolves.toEqual({
		status: 'skipped',
		reason: 'CAPABILITY_REINDEX_SECRET not set',
	})

	expect(fetchImplementation).not.toHaveBeenCalled()
	expect(logger.log).toHaveBeenCalledWith(
		'Skipping capability reindex (CAPABILITY_REINDEX_SECRET not set).',
	)
})

test('postDeployCapabilityReindex skips when the deploy URL is missing', async () => {
	const logger = createLogger()
	const fetchImplementation = vi.fn<typeof fetch>()

	await expect(
		postDeployCapabilityReindex({
			env: {
				CAPABILITY_REINDEX_SECRET: 'secret',
			},
			fetch: fetchImplementation,
			logger,
		}),
	).resolves.toEqual({
		status: 'skipped',
		reason: 'no deploy URL',
	})

	expect(fetchImplementation).not.toHaveBeenCalled()
	expect(logger.log).toHaveBeenCalledWith(
		'Skipping capability reindex (no deploy URL).',
	)
})

test('postDeployCapabilityReindex posts to the maintenance endpoint', async () => {
	const logger = createLogger()
	const fetchImplementation = vi.fn<typeof fetch>(async () => {
		return new Response(JSON.stringify({ ok: true }), { status: 200 })
	})

	await expect(
		postDeployCapabilityReindex({
			env: {
				CAPABILITY_REINDEX_SECRET: 'secret',
				DEPLOY_URL: 'https://kody.example.com/',
			},
			fetch: fetchImplementation,
			logger,
		}),
	).resolves.toEqual({
		status: 'ok',
		httpStatus: 200,
		body: JSON.stringify({ ok: true }),
	})

	expect(fetchImplementation).toHaveBeenCalledWith(
		'https://kody.example.com/__maintenance/reindex-capabilities',
		expect.objectContaining({
			method: 'POST',
			headers: {
				Accept: 'application/json',
				Authorization: 'Bearer secret',
			},
		}),
	)
	expect(logger.warn).not.toHaveBeenCalled()
})

test('postDeployCapabilityReindex warns and continues on HTTP failures', async () => {
	const logger = createLogger()
	const fetchImplementation = vi.fn<typeof fetch>(async () => {
		return new Response(
			JSON.stringify({ ok: false, error: 'reindex failed' }),
			{
				status: 500,
			},
		)
	})

	await expect(
		postDeployCapabilityReindex({
			env: {
				CAPABILITY_REINDEX_SECRET: 'secret',
				DEPLOY_URL: 'https://kody.example.com',
			},
			fetch: fetchImplementation,
			logger,
		}),
	).resolves.toEqual({
		status: 'failed',
		httpStatus: 500,
		body: JSON.stringify({ ok: false, error: 'reindex failed' }),
	})

	expect(logger.log).toHaveBeenCalledWith(
		JSON.stringify({ ok: false, error: 'reindex failed' }),
	)
	expect(logger.warn).toHaveBeenCalledWith(
		'::warning::Capability vector reindex returned HTTP 500. Continuing deploy.',
	)
})

test('postDeployCapabilityReindex warns and continues on network failures', async () => {
	const logger = createLogger()
	const fetchImplementation = vi.fn<typeof fetch>(async () => {
		throw new Error('connection reset')
	})

	await expect(
		postDeployCapabilityReindex({
			env: {
				CAPABILITY_REINDEX_SECRET: 'secret',
				DEPLOY_URL: 'https://kody.example.com',
			},
			fetch: fetchImplementation,
			logger,
		}),
	).resolves.toEqual({
		status: 'failed',
		error: 'connection reset',
	})

	expect(logger.warn).toHaveBeenCalledWith(
		'::warning::Capability vector reindex failed: connection reset. Continuing deploy.',
	)
})
