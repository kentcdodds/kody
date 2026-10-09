import { expect, test } from 'vitest'
import {
	parseReindexArgs,
	runCapabilityReindex,
} from './reindex-capabilities.ts'

function fakeMaintenanceEndpoint(
	responses: Array<{ status?: number; body: unknown }>,
) {
	const calls: Array<{ url: string; auth: string | null; body: unknown }> = []
	const fetcher: typeof fetch = async (input, init) => {
		const headers = new Headers(init?.headers)
		calls.push({
			url: String(input),
			auth: headers.get('Authorization'),
			body: JSON.parse(String(init?.body)),
		})
		const next = responses.shift()
		if (!next) throw new Error('unexpected extra sweep')
		return Response.json(next.body, { status: next.status ?? 200 })
	}
	return { calls, fetcher }
}

test('runCapabilityReindex threads each cursor into the next sweep until complete', async () => {
	const cursor = { phase: 'capabilities', afterId: 'cap-50' }
	const endpoint = fakeMaintenanceEndpoint([
		{ body: { complete: false, cursor } },
		{ body: { complete: true } },
	])
	const result = await runCapabilityReindex({
		baseUrl: 'https://kody-pr-3.example.workers.dev/',
		secret: 'reindex-secret',
		phases: ['capabilities'],
		force: true,
		fetcher: endpoint.fetcher,
		log: () => {},
	})
	expect(result).toEqual({ sweeps: 2 })
	expect(endpoint.calls).toEqual([
		{
			url: 'https://kody-pr-3.example.workers.dev/__maintenance/reindex-capabilities',
			auth: 'Bearer reindex-secret',
			body: { phases: ['capabilities'], force: true },
		},
		{
			url: 'https://kody-pr-3.example.workers.dev/__maintenance/reindex-capabilities',
			auth: 'Bearer reindex-secret',
			body: { phases: ['capabilities'], force: true, cursor },
		},
	])
})

test('runCapabilityReindex fails loudly on HTTP errors, missing cursors, and sweep exhaustion', async () => {
	const base = {
		baseUrl: 'https://kody-pr-3.example.workers.dev',
		secret: 's',
		log: () => {},
	}
	await expect(
		runCapabilityReindex({
			...base,
			fetcher: fakeMaintenanceEndpoint([
				{ status: 401, body: { error: 'Unauthorized' } },
			]).fetcher,
		}),
	).rejects.toThrow('Capability reindex failed with HTTP 401.')
	await expect(
		runCapabilityReindex({
			...base,
			fetcher: fakeMaintenanceEndpoint([{ body: { complete: false } }]).fetcher,
		}),
	).rejects.toThrow('incomplete but returned no cursor')
	const endless = { complete: false, cursor: { phase: 'jobs', afterId: null } }
	await expect(
		runCapabilityReindex({
			...base,
			maxSweeps: 2,
			fetcher: fakeMaintenanceEndpoint([{ body: endless }, { body: endless }])
				.fetcher,
		}),
	).rejects.toThrow('did not finish after 2 sweeps')
})

test('runCapabilityReindex refuses to send the secret over plain http to a remote host', async () => {
	const endpoint = fakeMaintenanceEndpoint([{ body: { complete: true } }])
	await expect(
		runCapabilityReindex({
			baseUrl: 'http://kody-pr-3.example.workers.dev',
			secret: 's',
			fetcher: endpoint.fetcher,
			log: () => {},
		}),
	).rejects.toThrow('Refusing to send the reindex secret')
	expect(endpoint.calls).toEqual([])
	await expect(
		runCapabilityReindex({
			baseUrl: 'http://localhost:3742',
			secret: 's',
			fetcher: endpoint.fetcher,
			log: () => {},
		}),
	).resolves.toEqual({ sweeps: 1 })
})

test('parseReindexArgs accepts known phases and omits phases for a full sweep', () => {
	expect(
		parseReindexArgs([
			'--url',
			'https://x.example',
			'--phases',
			'capabilities,packages',
			'--force',
			'--max-sweeps',
			'3',
		]),
	).toEqual({
		baseUrl: 'https://x.example',
		phases: ['capabilities', 'packages'],
		force: true,
		maxSweeps: 3,
	})
	expect(parseReindexArgs(['--url', 'https://x.example'])).toEqual({
		baseUrl: 'https://x.example',
		phases: undefined,
		force: false,
		maxSweeps: undefined,
	})
})
