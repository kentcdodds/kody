import { CAPABILITY_EMBEDDING_DIMENSIONS } from '#worker/vectorize/embedding.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { expect, test } from 'vitest'
import {
	deleteVectorizeIndex,
	ensureVectorizeIndex,
	vectorizeMetadataIndexProperties,
} from './vectorize-resources.ts'

type FakeIndex = { config: unknown; metadataIndexes: Array<string> }

function fakeVectorizeApi(
	options: { ignoreDeletes?: boolean; lookupStatus?: number } = {},
) {
	const indexes = new Map<string, FakeIndex>()
	const requests: Array<string> = []
	const ok = (result: unknown) => Response.json({ success: true, result })
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/vectorize\/v2\/indexes/, '')
		requests.push(`${method} ${path || '/'}`)
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		if (path === '' && method === 'POST') {
			indexes.set(body.name, { config: body.config, metadataIndexes: [] })
			return ok({ name: body.name })
		}
		const match = /^\/([^/]+)(\/.*)?$/.exec(path)
		const name = decodeURIComponent(match?.[1] ?? '')
		if (options.lookupStatus) {
			return Response.json(
				{
					success: false,
					errors: [{ code: 10000, message: 'Authentication error' }],
				},
				{ status: options.lookupStatus },
			)
		}
		const index = indexes.get(name)
		if (!index) {
			return Response.json(
				{ success: false, errors: [{ code: 3000, message: 'not found' }] },
				{ status: 404 },
			)
		}
		if (match?.[2] === '/metadata_index/list') {
			return ok({
				metadataIndexes: index.metadataIndexes.map((propertyName) => ({
					propertyName,
					indexType: 'String',
				})),
			})
		}
		if (match?.[2] === '/metadata_index/create') {
			index.metadataIndexes.push(body.propertyName)
			return ok({})
		}
		if (!match?.[2] && method === 'GET') return ok({ name })
		if (!match?.[2] && method === 'DELETE') {
			if (!options.ignoreDeletes) indexes.delete(name)
			return ok({})
		}
		throw new Error(`unexpected request ${method} ${url.pathname}`)
	}
	return { indexes, requests, fetcher }
}

const client = (fetcher: typeof fetch) => ({
	accountId: 'test-account',
	apiToken: 'test-token',
	dryRun: false,
	fetcher,
	sleep: async () => {},
})

test('ensureVectorizeIndex creates the embedding-shaped index with every filtered metadata index, then is idempotent', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	await ensureVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-7-vectors',
	})
	expect(api.indexes.get('kody-pr-7-vectors')).toEqual({
		config: { dimensions: CAPABILITY_EMBEDDING_DIMENSIONS, metric: 'cosine' },
		metadataIndexes: [...vectorizeMetadataIndexProperties],
	})

	api.indexes.get('kody-pr-7-vectors')!.metadataIndexes = ['kind', 'userId']
	api.requests.length = 0
	await ensureVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-7-vectors',
	})
	expect(api.requests).toEqual([
		'GET /kody-pr-7-vectors',
		'GET /kody-pr-7-vectors/metadata_index/list',
		'POST /kody-pr-7-vectors/metadata_index/create',
		'POST /kody-pr-7-vectors/metadata_index/create',
		'POST /kody-pr-7-vectors/metadata_index/create',
	])
	expect(api.indexes.get('kody-pr-7-vectors')!.metadataIndexes).toEqual([
		...vectorizeMetadataIndexProperties,
	])
})

test('deleteVectorizeIndex treats a missing index as success and fails loudly when the index survives the delete', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	await deleteVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	expect(api.requests).toEqual(['GET /kody-pr-8-vectors'])

	await ensureVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	await deleteVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	expect(api.indexes.has('kody-pr-8-vectors')).toBe(false)

	const stubborn = fakeVectorizeApi({ ignoreDeletes: true })
	await ensureVectorizeIndex({
		...client(stubborn.fetcher),
		name: 'kody-pr-9-vectors',
	})
	await expect(
		deleteVectorizeIndex({
			...client(stubborn.fetcher),
			name: 'kody-pr-9-vectors',
		}),
	).rejects.toThrow(
		'Failed to delete Vectorize index kody-pr-9-vectors: index still exists after delete',
	)

	const forbidden = fakeVectorizeApi({ lookupStatus: 403 })
	await expect(
		deleteVectorizeIndex({
			...client(forbidden.fetcher),
			name: 'kody-pr-9-vectors',
		}),
	).rejects.toThrow('Cloudflare API request failed (403)')
	expect(forbidden.requests).not.toContain('DELETE /kody-pr-9-vectors')
})

test('dry-run ensure and delete make no Cloudflare requests', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	await ensureVectorizeIndex({
		...client(api.fetcher),
		dryRun: true,
		name: 'kody-pr-10-vectors',
	})
	await deleteVectorizeIndex({
		...client(api.fetcher),
		dryRun: true,
		name: 'kody-pr-10-vectors',
	})
	expect(api.requests).toEqual([])
})
