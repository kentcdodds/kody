import { expect, test, vi } from 'vitest'

const {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	ensureArtifactRepoReady,
	getArtifactsBinding,
	getArtifactsNamespace,
	parseArtifactTokenSecret,
	resolveArtifactSourceHead,
	resolveArtifactSourceRepo,
	resolveExistingArtifactSourceRepo,
} = await import('./artifacts.ts')

test('artifacts REST client scopes API paths to configured or stored namespaces', async () => {
	const envBinding = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
		ARTIFACTS_NAMESPACE: 'preview',
	} as Env
	const bindingFetch = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			expect(url.pathname).toContain(
				'/artifacts/namespaces/preview/repos/repo-1',
			)
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
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
							remote:
								'https://acct.artifacts.cloudflare.net/git/preview/repo-1.git',
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
		})

	await expect(
		getArtifactsBinding(envBinding).get('repo-1'),
	).resolves.toMatchObject({
		status: 'ready',
	})
	expect(bindingFetch).toHaveBeenCalledTimes(1)
	bindingFetch.mockRestore()

	expect(getArtifactsNamespace({} as Env)).toBe('default')
	expect(
		getArtifactsNamespace({ ARTIFACTS_NAMESPACE: ' preview ' } as Env),
	).toBe('preview')
})

test('artifacts REST client supports get, create, token, and delete operations', async () => {
	let getRepo1Count = 0
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
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
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
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
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
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
			if (method === 'DELETE' && url.pathname.endsWith('/repos/repo-1')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo_1',
						},
						errors: [],
						messages: [],
					}),
					{
						status: 202,
						headers: { 'content-type': 'application/json' },
					},
				)
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

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
	await expect(binding.delete('repo-1')).resolves.toEqual({
		id: 'repo_1',
		alreadyDeleted: false,
	})

	expect(fetchMock).toHaveBeenCalledTimes(6)

	expect(parseArtifactTokenSecret('art_v1_secret?expires=1760000100')).toBe(
		'art_v1_secret',
	)
	expect(
		buildArtifactsGitAuth({ token: 'art_v1_secret?expires=1760000100' }),
	).toEqual({
		username: 'x',
		password: 'art_v1_secret',
	})
	expect(
		buildAuthenticatedArtifactsRemote({
			remote: 'http://127.0.0.1:8787/git/default/repo-1.git',
			token: 'art_v1_secret?expires=1760000100',
		}),
	).toBe('http://x:art_v1_secret@127.0.0.1:8787/git/default/repo-1.git')
})

test('ensureArtifactRepoReady handles concurrent create conflicts', async () => {
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	let getRepoCount = 0
	const recoverableFetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
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
							id: 'repo_1',
							name: 'repo-1',
							description: null,
							default_branch: 'main',
							created_at: '2026-04-18T00:00:00.000Z',
							updated_at: '2026-04-18T00:00:00.000Z',
							last_push_at: null,
							source: null,
							read_only: false,
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
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
						success: false,
						result: null,
						errors: [{ code: 10201, message: 'Create failed' }],
						messages: [],
					}),
					{
						status: 409,
						headers: { 'content-type': 'application/json' },
					},
				)
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	await expect(ensureArtifactRepoReady(env, 'repo-1')).resolves.toMatchObject({
		recreated: false,
		repo: expect.any(Object),
	})
	expect(recoverableFetchMock).toHaveBeenCalledTimes(3)
	recoverableFetchMock.mockRestore()

	const genericConflictFetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
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
			if (method === 'POST' && url.pathname.endsWith('/repos')) {
				return new Response(
					JSON.stringify({
						success: false,
						result: null,
						errors: [{ code: 9000, message: 'Different conflict' }],
						messages: [],
					}),
					{
						status: 409,
						headers: { 'content-type': 'application/json' },
					},
				)
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	await expect(ensureArtifactRepoReady(env, 'repo-1')).rejects.toThrow(
		'Different conflict',
	)
	expect(genericConflictFetchMock).toHaveBeenCalledTimes(2)
})

test('source repo HEAD lookup does not recreate missing artifact repos', async () => {
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
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
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	await expect(resolveExistingArtifactSourceRepo(env, 'repo-1')).resolves.toBe(
		null,
	)
	await expect(resolveArtifactSourceHead(env, 'repo-1')).resolves.toEqual({
		branch: 'main',
		commit: null,
	})
	expect(fetchMock).toHaveBeenCalledTimes(2)
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
		/Artifacts API request failed \(500\)/,
	)
})

test('artifacts REST client rejects tokens without parseable expiry timestamps', async () => {
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
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
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
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
		})

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	const binding = getArtifactsBinding(env)

	await expect(binding.create('repo-1')).rejects.toThrow(
		/parseable expires timestamp/,
	)
	expect(fetchMock).toHaveBeenCalledTimes(1)
})
