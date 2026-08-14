import { expect, test, vi } from 'vitest'

const gitMocks = vi.hoisted(() => ({
	listServerRefs: vi.fn(),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		listServerRefs: (...args: Array<unknown>) =>
			gitMocks.listServerRefs(...args),
	},
}))

vi.mock('isomorphic-git/http/web', () => ({
	default: {},
}))

const {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	ensureArtifactRepoReady,
	getArtifactsBinding,
	getArtifactsNamespace,
	parseArtifactTokenSecret,
	resolveArtifactDefaultBranchHead,
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

test('artifacts REST client error paths and missing source repos', async () => {
	expect(getArtifactsNamespace({} as Env)).toBe('default')
	expect(
		getArtifactsNamespace({ ARTIFACTS_NAMESPACE: ' preview ' } as Env),
	).toBe('preview')

	const missingRepoFetch = vi
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
	expect(missingRepoFetch).toHaveBeenCalledTimes(2)
	missingRepoFetch.mockRestore()

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
	await expect(getArtifactsBinding(env).get('repo-1')).rejects.toThrow(
		/Artifacts API request failed \(500\)/,
	)
	vi.mocked(globalThis.fetch).mockRestore()

	const invalidTokenFetch = vi
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
	await expect(getArtifactsBinding(env).create('repo-1')).rejects.toThrow(
		/parseable expires timestamp/,
	)
	expect(invalidTokenFetch).toHaveBeenCalledTimes(1)
})

test('resolveArtifactDefaultBranchHead reuses a provided token and still works without one', async () => {
	gitMocks.listServerRefs.mockReset()
	gitMocks.listServerRefs.mockResolvedValue([
		{ ref: 'refs/heads/main', oid: 'abc123' },
	])
	const createToken = vi.fn(async () => ({
		id: 'tok_read',
		plaintext: 'art_v1_throwaway',
		scope: 'read',
		expiresAt: '2026-10-09T08:55:00.000Z',
	}))
	const info = vi.fn(async () => ({
		id: 'repo_1',
		name: 'repo-1',
		description: null,
		defaultBranch: 'main',
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:00:00.000Z',
		lastPushAt: null,
		source: null,
		readOnly: false,
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
	}))
	const repo = { info, createToken }

	await expect(resolveArtifactDefaultBranchHead({ repo })).resolves.toEqual({
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
		defaultBranch: 'main',
		commit: 'abc123',
	})
	expect(createToken).toHaveBeenCalledTimes(1)
	expect(createToken).toHaveBeenCalledWith('read', 300)
	expect(gitMocks.listServerRefs).toHaveBeenCalledWith(
		expect.objectContaining({
			url: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
			prefix: 'refs/heads/main',
		}),
	)

	createToken.mockClear()
	info.mockClear()
	gitMocks.listServerRefs.mockClear()
	gitMocks.listServerRefs.mockResolvedValue([
		{ ref: 'refs/heads/main', oid: 'abc123' },
	])
	await expect(
		resolveArtifactDefaultBranchHead({
			repo,
			token: 'art_v1_reused_write',
			info: await info(),
		}),
	).resolves.toEqual({
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
		defaultBranch: 'main',
		commit: 'abc123',
	})
	expect(createToken).not.toHaveBeenCalled()
	expect(info).toHaveBeenCalledTimes(1)
	expect(gitMocks.listServerRefs).toHaveBeenCalledTimes(1)

	createToken.mockReset()
	createToken.mockResolvedValue({
		id: 'tok_empty',
		plaintext: undefined,
		scope: 'read',
		expiresAt: '2026-10-09T08:55:00.000Z',
	})
	await expect(resolveArtifactDefaultBranchHead({ repo })).rejects.toThrow(
		'Artifacts createToken result is missing plaintext.',
	)
	expect(gitMocks.listServerRefs).toHaveBeenCalledTimes(1)
})

test('native createToken maps token when JSRPC omits plaintext', async () => {
	const nativeCreateToken = vi.fn(async () => ({
		id: 'tok_native',
		token: 'art_v2_read?expires=1760000100',
		scope: 'read' as const,
	}))
	const env = {
		ARTIFACTS_NAMESPACE: 'production',
		ARTIFACTS: {
			create: vi.fn(),
			get: vi.fn(async () => ({
				id: 'repo_1',
				name: 'repo-1',
				description: null,
				defaultBranch: 'main',
				createdAt: '2026-04-17T00:00:00.000Z',
				updatedAt: '2026-04-17T00:00:00.000Z',
				lastPushAt: null,
				source: null,
				readOnly: false,
				remote:
					'https://acct.artifacts.cloudflare.net/git/production/repo-1.git',
				createToken: nativeCreateToken,
				listTokens: vi.fn(async () => ({ tokens: [], total: 0 })),
				revokeToken: vi.fn(),
			})),
			delete: vi.fn(),
			list: vi.fn(async () => ({ repos: [], total: 0 })),
		},
	} as unknown as Env

	const result = await getArtifactsBinding(env).get('repo-1')
	expect(result.status).toBe('ready')
	if (result.status !== 'ready') {
		throw new Error('expected native repo to be ready')
	}
	await expect(result.repo.createToken('read', 120)).resolves.toEqual({
		id: 'tok_native',
		plaintext: 'art_v2_read?expires=1760000100',
		scope: 'read',
		expiresAt: '2025-10-09T08:55:00.000Z',
	})
	expect(nativeCreateToken).toHaveBeenCalledWith('read', 120)
	expect(parseArtifactTokenSecret('art_v2_read?expires=1760000100')).toBe(
		'art_v2_read',
	)
	expect(() =>
		parseArtifactTokenSecret(undefined as unknown as string),
	).toThrow('Artifacts token plaintext is missing.')
	expect(() => parseArtifactTokenSecret('')).toThrow(
		'Artifacts token plaintext is missing.',
	)

	nativeCreateToken.mockResolvedValueOnce({
		id: 'tok_empty',
		scope: 'read' as const,
	})
	await expect(result.repo.createToken('read', 120)).rejects.toThrow(
		'Artifacts createToken result is missing plaintext.',
	)
})

test('ensureArtifactRepoReady uses the create result without a follow-up GET', async () => {
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-new')) {
				return new Response(
					JSON.stringify({
						success: false,
						result: null,
						errors: [{ code: 1000, message: 'Repo not found' }],
						messages: [],
					}),
					{
						status: 404,
						headers: {
							'content-type': 'application/json',
							'cf-ray': 'create-miss-ray',
						},
					},
				)
			}
			if (method === 'POST' && url.pathname.endsWith('/repos')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo_new',
							name: 'repo-new',
							description: null,
							default_branch: 'main',
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/repo-new.git',
							token: 'art_v1_create?expires=1760000000',
						},
						errors: [],
						messages: [],
					}),
					{
						status: 201,
						headers: {
							'content-type': 'application/json',
							'cf-ray': 'create-post-ray',
						},
					},
				)
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	await expect(ensureArtifactRepoReady(env, 'repo-new')).resolves.toMatchObject(
		{
			recreated: true,
			bootstrapAccess: {
				defaultBranch: 'main',
				remote:
					'https://acct.artifacts.cloudflare.net/git/default/repo-new.git',
				token: 'art_v1_create?expires=1760000000',
			},
			repo: expect.any(Object),
		},
	)
	expect(fetchMock).toHaveBeenCalledTimes(2)
	fetchMock.mockRestore()
})

test('getArtifactsBinding prefers the native ARTIFACTS binding for the env namespace', async () => {
	const created = {
		id: 'repo_native',
		name: 'repo-native',
		description: null,
		defaultBranch: 'main',
		remote:
			'https://acct.artifacts.cloudflare.net/git/production/repo-native.git',
		token: 'art_v2_native',
		tokenExpiresAt: '2026-10-09T08:53:20.000Z',
	}
	const nativeGet = vi.fn(async () => {
		const error = new Error('not found') as Error & {
			name: string
			code: string
		}
		error.name = 'ArtifactsError'
		error.code = 'NOT_FOUND'
		throw error
	})
	const nativeCreate = vi.fn(async () => created)
	const env = {
		ARTIFACTS_NAMESPACE: 'production',
		ARTIFACTS: {
			create: nativeCreate,
			get: nativeGet,
			delete: vi.fn(async () => true),
			list: vi.fn(async () => ({ repos: [], total: 0 })),
		},
	} as unknown as Env

	const binding = getArtifactsBinding(env)
	await expect(binding.get('repo-native')).resolves.toEqual({
		status: 'not_found',
	})
	await expect(
		ensureArtifactRepoReady(env, 'repo-native', binding),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: created.remote,
			token: created.token,
			expiresAt: created.tokenExpiresAt,
		},
	})
	expect(nativeCreate).toHaveBeenCalledWith('repo-native', { readOnly: false })
	expect(nativeGet).toHaveBeenCalledTimes(2)

	const duckTypedNotFound = {
		name: 'ArtifactsError',
		code: 'NOT_FOUND',
		message: 'Repository not found: repo-native-duck',
	}
	nativeGet.mockReset()
	nativeGet.mockImplementation(async () => {
		throw duckTypedNotFound
	})
	nativeCreate.mockClear()
	nativeCreate.mockImplementation(async () => ({
		id: 'repo_native_duck',
		name: 'repo-native-duck',
		description: null,
		defaultBranch: 'main',
		remote:
			'https://acct.artifacts.cloudflare.net/git/production/repo-native-duck.git',
		token: 'art_v2_native?expires=1760000000',
	}))
	await expect(binding.get('repo-native-duck')).resolves.toEqual({
		status: 'not_found',
	})
	await expect(
		ensureArtifactRepoReady(env, 'repo-native-duck', binding),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			token: 'art_v2_native?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
	})
	expect(nativeCreate).toHaveBeenCalledWith('repo-native-duck', {
		readOnly: false,
	})

	nativeGet.mockReset()
	nativeGet.mockImplementation(async () => {
		throw {
			name: 'ArtifactsError',
			message: 'Repository not found: repo-native-message-only',
		}
	})
	await expect(binding.get('repo-native-message-only')).resolves.toEqual({
		status: 'not_found',
	})
	nativeGet.mockReset()
	nativeGet.mockImplementation(async () => {
		throw new Error('git: repository not found on the remote')
	})
	await expect(binding.get('repo-unrelated-not-found')).rejects.toThrow(
		/git: repository not found/,
	)
	nativeGet.mockReset()
	nativeGet.mockImplementation(async () => {
		throw new Error(
			'ArtifactsError: Repository not found: repo-native-prefixed',
		)
	})
	await expect(binding.get('repo-native-prefixed')).resolves.toEqual({
		status: 'not_found',
	})

	nativeGet.mockReset()
	nativeGet.mockImplementation(async () => {
		throw {
			name: 'ArtifactsError',
			code: 'NOT_FOUND',
			message: 'Repository not found: repo-native-no-exp',
		}
	})
	nativeCreate.mockImplementation(async () => ({
		id: 'repo_native_no_exp',
		name: 'repo-native-no-exp',
		description: null,
		defaultBranch: 'main',
		remote:
			'https://acct.artifacts.cloudflare.net/git/production/repo-native-no-exp.git',
		token: 'art_v2_native?expires=1760000000',
	}))
	await expect(
		ensureArtifactRepoReady(env, 'repo-native-no-exp', binding),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			token: 'art_v2_native?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
	})

	const readyHandle = {
		id: 'repo_exists',
		name: 'repo-native-exists',
		description: null,
		defaultBranch: 'main',
		createdAt: '2026-08-13T00:00:00.000Z',
		updatedAt: '2026-08-13T00:00:00.000Z',
		lastPushAt: null,
		source: null,
		readOnly: false,
		remote:
			'https://acct.artifacts.cloudflare.net/git/production/repo-native-exists.git',
		createToken: vi.fn(),
		listTokens: vi.fn(),
		revokeToken: vi.fn(),
	}
	let existsGets = 0
	nativeGet.mockReset()
	nativeGet.mockImplementation(async () => {
		existsGets += 1
		if (existsGets === 1) {
			throw {
				name: 'ArtifactsError',
				code: 'NOT_FOUND',
				message: 'Repository not found: repo-native-exists',
			}
		}
		return readyHandle
	})
	nativeCreate.mockReset()
	nativeCreate.mockImplementation(async () => {
		throw {
			name: 'ArtifactsError',
			code: 'ALREADY_EXISTS',
			message: 'Repository already exists: repo-native-exists',
		}
	})
	await expect(
		ensureArtifactRepoReady(env, 'repo-native-exists', binding),
	).resolves.toMatchObject({
		recreated: false,
		repo: expect.any(Object),
	})
	expect(nativeCreate).toHaveBeenCalledTimes(1)
	expect(existsGets).toBeGreaterThan(1)
})

test('artifacts REST logs redact plaintext tokens on revoke', async () => {
	const plaintext = 'art_v1_secret?expires=1760000100'
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			expect(method).toBe('DELETE')
			expect(url.pathname).toContain(`/tokens/${encodeURIComponent(plaintext)}`)
			return new Response(
				JSON.stringify({
					success: true,
					result: null,
					errors: [],
					messages: [],
				}),
				{
					status: 200,
					headers: {
						'content-type': 'application/json',
						'cf-ray': 'revoke-ray-1',
					},
				},
			)
		})

	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env
	await getArtifactsBinding(env).repo('repo-1').revokeToken?.(plaintext)

	const logged = info.mock.calls.filter((call) => call[0] === 'artifacts-rest')
	expect(logged).toHaveLength(1)
	expect(logged[0]?.[1]).toEqual({
		method: 'DELETE',
		path: '/client/v4/accounts/acct/artifacts/namespaces/default/tokens/:token',
		status: 200,
		cfRay: 'revoke-ray-1',
	})
	expect(JSON.stringify(logged)).not.toContain(plaintext)
	expect(JSON.stringify(logged)).not.toContain(encodeURIComponent(plaintext))
	info.mockRestore()
	fetchMock.mockRestore()
})
