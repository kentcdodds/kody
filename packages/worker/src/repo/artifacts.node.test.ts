import { afterEach, expect, test, vi } from 'vitest'

const {
	getArtifactsBinding,
	resolveArtifactSourceRepo,
	resolveSessionRepo,
} = await import('./artifacts.ts')

afterEach(() => {
	vi.restoreAllMocks()
})

test('artifacts REST client supports get, create, token, and fork operations', async () => {
	let getRepo1Count = 0
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
		async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
				getRepo1Count += 1
				if (getRepo1Count === 1) {
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
							id: 'repo_1',
							name: 'repo-1',
							description: 'Repo 1',
							default_branch: 'main',
							created_at: '2026-04-17T00:00:00.000Z',
							updated_at: '2026-04-17T00:00:00.000Z',
							last_push_at: null,
							source: null,
							read_only: false,
							remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
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
							id: 'repo_1',
							name: 'repo-1',
							description: null,
							default_branch: 'main',
							remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
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
			if (method === 'POST' && url.pathname.endsWith('/tokens')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'tok_1',
							plaintext: 'art_v1_read?expires=1760000100',
							scope: 'read',
							expires_at: '2026-10-09T08:55:00.000Z',
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
			if (method === 'POST' && url.pathname.endsWith('/repos/repo-1/fork')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo_2',
							name: 'repo-copy',
							description: null,
							default_branch: 'main',
							remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-copy.git',
							token: 'art_v1_fork?expires=1760000200',
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

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	const binding = getArtifactsBinding(env)
	await expect(binding.get('repo-1')).resolves.toEqual({ status: 'not_found' })
	await expect(binding.create('repo-1')).resolves.toMatchObject({
		id: 'repo_1',
		name: 'repo-1',
		defaultBranch: 'main',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
		token: 'art_v1_create?expires=1760000000',
	})

	const repo = await resolveArtifactSourceRepo(env, 'repo-1')
	await expect(repo.info()).resolves.toMatchObject({
		id: 'repo_1',
		name: 'repo-1',
		defaultBranch: 'main',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
	})
	await expect(repo.createToken('read', 120)).resolves.toEqual({
		id: 'tok_1',
		plaintext: 'art_v1_read?expires=1760000100',
		scope: 'read',
		expiresAt: '2026-10-09T08:55:00.000Z',
	})
	await expect(repo.fork({ name: 'repo-copy', readOnly: false })).resolves.toMatchObject(
		{
			id: 'repo_2',
			name: 'repo-copy',
			defaultBranch: 'main',
			remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-copy.git',
			token: 'art_v1_fork?expires=1760000200',
		},
	)

	expect(fetchMock).toHaveBeenCalledTimes(6)
})

test('artifacts REST client uses fallback API error text when envelope errors are missing', async () => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(
			JSON.stringify({
				success: false,
				result: null,
				messages: [],
			}),
			{
				status: 500,
				headers: { 'content-type': 'application/json' },
			},
		),
	)

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	const binding = getArtifactsBinding(env)

	await expect(binding.get('repo-1')).rejects.toThrow(
		'Artifacts API request failed (500).',
	)
})

test('artifacts REST client maps 202 repo responses into pending state', async () => {
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
		async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
				return new Response(
					JSON.stringify({
						success: false,
						result: null,
						errors: [],
						messages: [{ code: 1000, message: 'Repo importing. Retry after 7s.' }],
					}),
					{
						status: 202,
						headers: {
							'content-type': 'application/json',
							'retry-after': '7',
						},
					},
				)
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		},
	)

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	const binding = getArtifactsBinding(env)

	await expect(binding.get('repo-1')).resolves.toEqual({
		status: 'importing',
		retryAfter: 2,
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('artifacts REST client tolerates repo tokens without parseable expiry timestamps', async () => {
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
		async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'POST' && url.pathname.endsWith('/repos')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo_1',
							name: 'repo-1',
							description: null,
							default_branch: 'main',
							remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
							token: 'art_v1_missing_expiry',
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

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	const binding = getArtifactsBinding(env)

	await expect(binding.create('repo-1')).resolves.toMatchObject({
		id: 'repo_1',
		name: 'repo-1',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
		token: 'art_v1_missing_expiry',
		expiresAt: null,
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('resolveSessionRepo uses the requested namespace override', async () => {
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
		async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			expect(method).toBe('GET')
			expect(url.pathname).toContain('/artifacts/namespaces/session-ns/repos/repo-1')
			return new Response(
				JSON.stringify({
					success: true,
					result: {
						id: 'repo_1',
						name: 'repo-1',
						description: null,
						default_branch: 'main',
						created_at: '2026-04-17T00:00:00.000Z',
						updated_at: '2026-04-17T00:00:00.000Z',
						last_push_at: null,
						source: null,
						read_only: false,
						remote: 'https://acct.artifacts.cloudflare.net/git/session-ns/repo-1.git',
					},
					errors: [],
					messages: [],
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' },
				},
			)
		},
	)

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
		ARTIFACTS_NAMESPACE: 'env-default',
	} as Env

	const repo = await resolveSessionRepo(env, {
		namespace: 'session-ns',
		name: 'repo-1',
	})

	await expect(repo.info()).resolves.toMatchObject({
		name: 'repo-1',
		remote: 'https://acct.artifacts.cloudflare.net/git/session-ns/repo-1.git',
	})
	expect(fetchMock).toHaveBeenCalledTimes(2)
})
