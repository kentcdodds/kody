import { afterEach, expect, test, vi } from 'vitest'

const { ensureEntitySource } = await import('./source-service.ts')

afterEach(() => {
	vi.restoreAllMocks()
})

test('ensureEntitySource fails closed when durable persistence is required without Artifacts REST credentials', async () => {
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null
						},
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		ensureEntitySource({
			db,
			env: { APP_DB: db } as Env,
			userId: 'user-1',
			entityKind: 'app',
			entityId: 'app-1',
			sourceRoot: '/',
			requirePersistence: true,
		}),
	).rejects.toThrow(
		'Repo-backed source persistence requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
	)
})

test('ensureEntitySource returns bootstrap access for brand-new repos', async () => {
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (query.includes('FROM entity_sources')) {
								return null
							}
							return null
						},
						async run() {
							if (query.includes('INSERT INTO entity_sources')) {
								return { meta: { changes: 1 } }
							}
							throw new Error(`Unexpected run query: ${query} ${params.join(',')}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database

	let getRepoCount = 0
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
		async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (
				method === 'GET' &&
				url.pathname.endsWith('/repos/skill-skill-1')
			) {
				getRepoCount += 1
				if (getRepoCount === 1) {
					return new Response(
						JSON.stringify({
							success: false,
							result: null,
							errors: [{ code: 1000, message: 'Repo not found' }],
							messages: [],
						}),
						{
							status: 404,
							headers: { 'content-type': 'application/json' },
						},
					)
				}
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo-1',
							name: 'skill-skill-1',
							description: null,
							default_branch: 'main',
							created_at: '2026-04-18T00:00:00.000Z',
							updated_at: '2026-04-18T00:00:00.000Z',
							last_push_at: null,
							source: null,
							read_only: false,
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/skill-skill-1.git',
						},
						errors: [],
						messages: [],
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' },
					},
				)
			}
			if (method === 'POST' && url.pathname.endsWith('/repos')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo-1',
							name: 'skill-skill-1',
							description: null,
							default_branch: 'main',
							remote: 'https://acct.artifacts.cloudflare.net/git/default/skill-skill-1.git',
							token: 'art_v1_create?expires=1760000000',
						},
						errors: [],
						messages: [],
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' },
					},
				)
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		},
	)

	const source = await ensureEntitySource({
		db,
		env: {
			APP_DB: db,
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token-123',
			CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
		} as Env,
		userId: 'user-1',
		entityKind: 'skill',
		entityId: 'skill-1',
		sourceRoot: '/',
	})

	expect(fetchMock).toHaveBeenCalledTimes(3)
	expect(source.repo_id).toBe('skill-skill-1')
	expect(source.bootstrapAccess).toEqual({
		defaultBranch: 'main',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/skill-skill-1.git',
		token: 'art_v1_create?expires=1760000000',
		expiresAt: '2025-10-09T08:53:20.000Z',
	})
})
