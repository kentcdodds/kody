import { expect, test } from 'vitest'
import {
	buildSeededPublicCodeRunsWindow,
	defaultSeedDelta,
	findKvNamespaceId,
	parseSeedPublicCodeRunsArgs,
	putPublicCodeRunsWindow,
	readLiveCodeRunsCurrent,
	resolveSeededCodeRunsCounts,
} from './seed-public-code-runs.ts'
import { publicCodeRunsKvKey } from '#universal/code-runs.ts'

test('seed-public-code-runs reads the live current, builds a 24h pair, and puts it', async () => {
	const args = parseSeedPublicCodeRunsArgs([
		'--delta',
		'86400',
		'--now',
		'2026-08-22T16:00:00.000Z',
		'--url',
		'https://kody.codes/code-runs.json',
		'--kv-title',
		'kody-bundle-artifacts',
	])
	expect(args).toMatchObject({
		delta: defaultSeedDelta,
		dryRun: false,
		codeRunsJsonUrl: 'https://kody.codes/code-runs.json',
		kvTitle: 'kody-bundle-artifacts',
	})
	expect(
		resolveSeededCodeRunsCounts({
			liveCurrent: 171540,
			delta: args.delta,
		}),
	).toEqual({ previous: 171540, current: 257940 })

	const window = buildSeededPublicCodeRunsWindow({
		liveCurrent: 171540,
		delta: args.delta,
		now: args.now ?? new Date('2026-08-22T16:00:00.000Z'),
	})
	expect(window).toEqual({
		previous: 171540,
		current: 257940,
		windowStart: '2026-08-22T16:00:00.000Z',
		windowEnd: '2026-08-23T16:00:00.000Z',
	})

	const liveCurrent = await readLiveCodeRunsCurrent(
		'https://kody.codes/code-runs.json',
		async () =>
			new Response(
				JSON.stringify({
					ok: true,
					window: {
						previous: 171540,
						current: 171540,
						windowStart: '2026-08-22T15:34:14.374Z',
						windowEnd: '2026-08-23T15:34:14.374Z',
					},
				}),
			),
	)
	expect(liveCurrent).toBe(171540)

	const requested: Array<string> = []
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input)
		requested.push(`${init?.method ?? 'GET'} ${url}`)
		if (url.includes('/storage/kv/namespaces') && !url.includes('/values/')) {
			return new Response(
				JSON.stringify({
					success: true,
					result: [{ id: 'kv-bundle-id', title: 'kody-bundle-artifacts' }],
					result_info: { page: 1, total_pages: 1 },
				}),
			)
		}
		if (url.includes(`/values/${encodeURIComponent(publicCodeRunsKvKey)}`)) {
			expect(init?.method).toBe('PUT')
			expect(init?.body).toBe(JSON.stringify(window))
			return new Response(JSON.stringify({ success: true }))
		}
		throw new Error(`unexpected fetch: ${url}`)
	}

	const namespaceId = await findKvNamespaceId({
		accountId: 'account-1',
		apiToken: 'token-1',
		title: 'kody-bundle-artifacts',
		fetchImpl,
	})
	await putPublicCodeRunsWindow({
		accountId: 'account-1',
		apiToken: 'token-1',
		namespaceId,
		window,
		fetchImpl,
	})
	expect(namespaceId).toBe('kv-bundle-id')
	expect(requested.some((entry) => entry.startsWith('PUT '))).toBe(true)
})

test('seed-public-code-runs keeps an explicit previous and rejects a lower current', () => {
	expect(
		resolveSeededCodeRunsCounts({
			liveCurrent: 171540,
			previous: 150000,
			current: 171540,
			delta: 1,
		}),
	).toEqual({ previous: 150000, current: 171540 })
	expect(() =>
		resolveSeededCodeRunsCounts({
			liveCurrent: 171540,
			previous: 171540,
			current: 100,
			delta: 1,
		}),
	).toThrow('current must be an integer >= previous')
})
