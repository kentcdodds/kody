import { afterEach, expect, test, vi } from 'vitest'

const {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	ensureArtifactRepoReady,
	getArtifactsBinding,
	getArtifactsNamespace,
	parseArtifactTokenSecret,
	resolveArtifactSourceRepo,
	resolveSessionRepo,
} = await import('./artifacts.ts')

afterEach(() => {
	vi.restoreAllMocks()
})

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

	const envSession = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
		ARTIFACTS_NAMESPACE: 'production',
	} as Env
	const sessionFetch = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			expect(url.pathname).toContain(
				'/artifacts/namespaces/legacy-default/repos/session-repo',
			)
			if (method === 'GET' && url.pathname.endsWith('/repos/session-repo')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo_session',
							name: 'session-repo',
							description: null,
							default_branch: 'main',
							created_at: '2026-04-17T00:00:00.000Z',
							updated_at: '2026-04-17T00:00:00.000Z',
							last_push_at: null,
							source: null,
							read_only: false,
							remote:
								'https://acct.artifacts.cloudflare.net/git/legacy-default/session-repo.git',
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
		resolveSessionRepo(envSession, {
			namespace: 'legacy-default',
			name: 'session-repo',
		}),
	).resolves.toMatchObject({
		info: expect.any(Function),
	})
	expect(sessionFetch).toHaveBeenCalledTimes(1)
})

test('getArtifactsNamespace defaults to default and trims configured values', () => {
	expect(getArtifactsNamespace({} as Env)).toBe('default')
	expect(
		getArtifactsNamespace({ ARTIFACTS_NAMESPACE: ' preview ' } as Env),
	).toBe('preview')
})

test('artifacts REST client supports get, create, token, and fork operations', async () => {
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
			if (method === 'POST' && url.pathname.endsWith('/repos/repo-1/fork')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo_2',
							name: 'repo-copy',
							description: null,
							default_branch: 'main',
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/repo-copy.git',
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
	await expect(
		repo.fork({ name: 'repo-copy', readOnly: false }),
	).resolves.toMatchObject({
		id: 'repo_2',
		name: 'repo-copy',
		defaultBranch: 'main',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-copy.git',
		token: 'art_v1_fork?expires=1760000200',
	})
	await expect(binding.delete('repo-1')).resolves.toEqual({
		id: 'repo_1',
		alreadyDeleted: false,
	})

	expect(fetchMock).toHaveBeenCalledTimes(7)
})

test('resolveArtifactSourceRepo recreates missing source repos', async () => {
	let getRepoCount = 0
	const fetchMock = vi
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
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	const repo = await resolveArtifactSourceRepo(env, 'repo-1')

	expect(repo).toHaveProperty('info', expect.any(Function))
	expect(fetchMock).toHaveBeenCalledTimes(3)
})

test('ensureArtifactRepoReady rereads after concurrent create conflicts', async () => {
	let getRepoCount = 0
	const fetchMock = vi
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
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	await expect(ensureArtifactRepoReady(env, 'repo-1')).resolves.toMatchObject({
		recreated: false,
		repo: expect.any(Object),
	})
	expect(fetchMock).toHaveBeenCalledTimes(3)
})

test('ensureArtifactRepoReady does not swallow generic create conflicts', async () => {
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
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env

	await expect(ensureArtifactRepoReady(env, 'repo-1')).rejects.toThrow(
		'Different conflict',
	)
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
		'Artifacts API request failed (500).',
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
		'Artifacts token is missing a parseable expires timestamp.',
	)
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('artifacts git auth uses x username and strips expiry from password', () => {
	expect(parseArtifactTokenSecret('art_v1_secret?expires=1760000100')).toBe(
		'art_v1_secret',
	)
	expect(
		buildArtifactsGitAuth({ token: 'art_v1_secret?expires=1760000100' }),
	).toEqual({
		username: 'x',
		password: 'art_v1_secret',
	})
})

test('authenticated artifact remotes allow loopback http for local mocks', () => {
	expect(
		buildAuthenticatedArtifactsRemote({
			remote: 'http://127.0.0.1:8787/git/default/repo-1.git',
			token: 'art_v1_secret?expires=1760000100',
		}),
	).toBe('http://x:art_v1_secret@127.0.0.1:8787/git/default/repo-1.git')
})
