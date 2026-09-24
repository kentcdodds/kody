import { expect, test } from 'vitest'
import { createTemporaryModuleGraph } from '#worker/test-support/module-graph.ts'
import { prepareKodyGraphFiles } from './module-graph-import-rewriting.ts'
import { applyXSearchRecentPaginationPatch } from './x-search-recent-pagination.ts'

function cleanObjectSource() {
	return [
		'function cleanObject(input) {',
		'  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""))',
		'}',
	].join('\n')
}

function unpatchedClientSource() {
	return [
		cleanObjectSource(),
		'export async function searchRecent(params) {',
		'\tconst query = cleanObject({',
		'\t\tquery: params.query,',
		'\t\tmax_results: params.maxResults || params.max_results || 10,',
		"\t\t'tweet.fields': params.tweetFields,",
		'\t\texpansions: params.expansions,',
		"\t\t'user.fields': params.userFields,",
		'\t})',
		"\tconst path = '/tweets/search/recent'",
		'\treturn { query, path }',
		'}',
		'export async function getUserTweets(params) {',
		'\tconst query = cleanObject({',
		'\t\tmax_results: params.maxResults || params.max_results || 10,',
		'\t\tpagination_token: params.paginationToken || params.pagination_token,',
		'\t})',
		'\treturn query',
		'}',
	].join('\n')
}

function unpatchedTypesSource() {
	return [
		'export type XSearchRecentParams = XAccountParams & {',
		'\tquery: string',
		'\tmaxResults?: number',
		'\tmax_results?: number',
		'\ttweetFields?: string',
		'\texpansions?: string',
		'\tuserFields?: string',
		'\tauthMode?: XAuthMode',
		'}',
		'export type XGetUserTweetsParams = XAccountParams & {',
		'\tmax_results?: number',
		'\tpagination_token?: string',
		'}',
	].join('\n')
}

function unpatchedEntrySource() {
	return [
		"import { searchRecent } from './client.ts'",
		'/**',
		' * Search recent public X posts with app-only bearer auth by default.',
		' * @returns X API search results with tweets and optional expansions.',
		' */',
		'export default async function searchRecentEntrypoint(params) {',
		'  return await searchRecent(params)',
		'}',
	].join('\n')
}

test('search-recent forwards next_token and leaves user-tweet pagination alone', async () => {
	const original = {
		'src/client.ts': unpatchedClientSource(),
		'src/types.ts': unpatchedTypesSource(),
		'src/search-recent.ts': unpatchedEntrySource(),
		'node_modules/other/client.ts': unpatchedClientSource(),
	}
	const patched = applyXSearchRecentPaginationPatch(original)
	expect(patched.changed).toBe(true)
	expect(patched.files['node_modules/other/client.ts']).toBe(
		original['node_modules/other/client.ts'],
	)
	const client = patched.files['src/client.ts'] ?? ''
	expect(client).toContain('next_token: params.nextToken || params.next_token,')
	expect(client).not.toContain('pagination_token: params.nextToken')
	const userTweets = client.slice(client.indexOf('function getUserTweets'))
	expect(userTweets).not.toContain('next_token')
	expect(patched.files['src/types.ts']).toContain('nextToken?: string')
	expect(patched.files['src/types.ts']).toContain('next_token?: string')
	expect(patched.files['src/types.ts']).not.toMatch(
		/XGetUserTweetsParams[\s\S]*next_token\?: string/,
	)
	expect(patched.files['src/search-recent.ts']).toContain(
		'Pass `next_token` or `nextToken` from the previous `meta.next_token`',
	)

	const again = applyXSearchRecentPaginationPatch(patched.files)
	expect(again.changed).toBe(false)
	expect(again.files).toBe(patched.files)

	const graph = await createTemporaryModuleGraph({
		'client.js': client,
	})
	try {
		const mod = (await graph.importModule('client.js')) as {
			searchRecent: (params: Record<string, unknown>) => Promise<{
				query: Record<string, unknown>
			}>
			getUserTweets: (
				params: Record<string, unknown>,
			) => Promise<Record<string, unknown>>
		}
		const firstPage = await mod.searchRecent({ query: 'conversation_id:1' })
		expect(firstPage.query).not.toHaveProperty('next_token')
		expect(firstPage.query).not.toHaveProperty('pagination_token')
		expect(
			(
				await mod.searchRecent({
					query: 'conversation_id:1',
					next_token: 'page-2',
					max_results: 10,
				})
			).query.next_token,
		).toBe('page-2')
		expect(
			(
				await mod.searchRecent({
					query: 'conversation_id:1',
					nextToken: 'page-3',
				})
			).query.next_token,
		).toBe('page-3')
		expect(
			(
				await mod.searchRecent({
					query: 'conversation_id:1',
					next_token: '',
				})
			).query,
		).not.toHaveProperty('next_token')
		const tweets = await mod.getUserTweets({ pagination_token: 'user-page' })
		expect(tweets.pagination_token).toBe('user-page')
		expect(tweets).not.toHaveProperty('next_token')
	} finally {
		await graph.cleanup()
	}
})

test('a package that already sends next_token is not rewritten', () => {
	const files = {
		'src/client.ts': unpatchedClientSource().replace(
			"'tweet.fields': params.tweetFields,",
			"next_token: params.nextToken || params.next_token,\n\t\t'tweet.fields': params.tweetFields,",
		),
	}
	const patched = applyXSearchRecentPaginationPatch(files)
	expect(patched.changed).toBe(false)
	expect(patched.files).toBe(files)
})

test('root package source is patched before the module graph is bundled', async () => {
	const prepared = await prepareKodyGraphFiles({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/x',
				exports: { '.': './src/search-recent.ts' },
				kody: { id: 'x', description: 'X' },
			}),
			'src/search-recent.ts': unpatchedEntrySource(),
			'src/client.ts': unpatchedClientSource(),
		},
		entryPoint: 'src/search-recent.ts',
	})
	const client = Object.entries(prepared.files).find(([path]) =>
		path.endsWith('/src/client.ts'),
	)?.[1]
	expect(client).toContain('next_token: params.nextToken || params.next_token,')
	const entry = Object.entries(prepared.files).find(([path]) =>
		path.endsWith('/src/search-recent.ts'),
	)?.[1]
	expect(entry).toContain('meta.next_token')
})
