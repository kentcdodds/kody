import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	waitUntil: vi.fn((promise: Promise<unknown>) => {
		void promise
	}),
	ensureArtifactsRepoPushSubscription: vi.fn(async () => ({
		subscriptionId: null,
		skipped: true,
	})),
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('cloudflare:workers')>()
	return {
		...actual,
		waitUntil: (...args: Array<unknown>) => mocks.waitUntil(...args),
	}
})

vi.mock('./artifacts-push-subscriptions.ts', () => ({
	ensureArtifactsRepoPushSubscription: (...args: Array<unknown>) =>
		mocks.ensureArtifactsRepoPushSubscription(...args),
}))

const { ensureEntitySource } = await import('./source-service.ts')

function createEntitySourceRow() {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'abc123',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
}

function createEmptyEntitySourcesDb() {
	return {
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
}

function createArtifactsFetchMock(options: {
	repoName: string
	getRepoCountRef: { value: number }
}) {
	return vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (
				method === 'GET' &&
				url.pathname.endsWith(`/repos/${options.repoName}`)
			) {
				options.getRepoCountRef.value += 1
				if (options.getRepoCountRef.value === 1) {
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
							name: options.repoName,
							description: null,
							default_branch: 'main',
							created_at: '2026-04-18T00:00:00.000Z',
							updated_at: '2026-04-18T00:00:00.000Z',
							last_push_at: null,
							source: null,
							read_only: false,
							remote: `https://acct.artifacts.cloudflare.net/git/default/${options.repoName}.git`,
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
							name: options.repoName,
							description: null,
							default_branch: 'main',
							remote: `https://acct.artifacts.cloudflare.net/git/default/${options.repoName}.git`,
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
}

test('ensureEntitySource workflow: fail-closed, bootstrap, recreate missing repo, reuse ready repo', async () => {
	const emptyDb = createEmptyEntitySourcesDb()
	await expect(
		ensureEntitySource({
			db: emptyDb,
			env: { APP_DB: emptyDb } as Env,
			userId: 'user-1',
			entityKind: 'job',
			entityId: 'job-1',
			sourceRoot: '/',
			requirePersistence: true,
		}),
	).rejects.toThrow()

	const newJobDb = {
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
							throw new Error(
								`Unexpected run query: ${query} ${params.join(',')}`,
							)
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const newJobGetRepoCount = { value: 0 }
	const newJobFetchMock = createArtifactsFetchMock({
		repoName: 'job-job-1',
		getRepoCountRef: newJobGetRepoCount,
	})

	try {
		const serverTiming: Array<{ name: string; durationMs: number }> = []
		const newSource = await ensureEntitySource({
			db: newJobDb,
			env: {
				APP_DB: newJobDb,
				CLOUDFLARE_ACCOUNT_ID: 'acct',
				CLOUDFLARE_API_TOKEN: 'token-123',
				CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
			} as Env,
			userId: 'user-1',
			entityKind: 'job',
			entityId: 'job-1',
			sourceRoot: '/',
			serverTiming,
		})

		expect(newJobFetchMock).toHaveBeenCalledTimes(2)
		expect(newSource.repo_id).toBe('job-job-1')
		expect(newSource.bootstrapAccess).toEqual({
			defaultBranch: 'main',
			remote: 'https://acct.artifacts.cloudflare.net/git/default/job-job-1.git',
			token: 'art_v1_create?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		})
		expect(serverTiming.map((entry) => entry.name)).toEqual([
			'artifacts-repo-ready',
			'entity-source-insert',
		])
		expect(mocks.waitUntil).toHaveBeenCalledTimes(0)
	} finally {
		newJobFetchMock.mockRestore()
		// Restore settled defaults before later phases so hanging push-subscription
		// promises and a no-op waitUntil do not leak across the merged workflow.
		mocks.ensureArtifactsRepoPushSubscription.mockReset()
		mocks.ensureArtifactsRepoPushSubscription.mockResolvedValue({
			subscriptionId: null,
			skipped: true,
		})
		mocks.waitUntil.mockReset()
		mocks.waitUntil.mockImplementation((promise: Promise<unknown>) => {
			void promise
		})
	}

	const existingRow = createEntitySourceRow()
	const recreateRunMock = vi.fn(async () => ({ meta: { changes: 1 } }))
	const recreateDb = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async first() {
							if (query.includes('FROM entity_sources')) {
								return existingRow
							}
							return null
						},
						run: recreateRunMock,
					}
				},
			}
		},
	} as unknown as D1Database

	const recreateGetRepoCount = { value: 0 }
	const recreateFetchMock = createArtifactsFetchMock({
		repoName: 'package-package-1',
		getRepoCountRef: recreateGetRepoCount,
	})

	try {
		const recreatedSource = await ensureEntitySource({
			db: recreateDb,
			env: {
				APP_DB: recreateDb,
				CLOUDFLARE_ACCOUNT_ID: 'acct',
				CLOUDFLARE_API_TOKEN: 'token-123',
				CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
			} as Env,
			userId: 'user-1',
			entityKind: 'package',
			entityId: 'package-1',
			sourceRoot: '/',
		})

		expect(recreateFetchMock).toHaveBeenCalledTimes(2)
		expect(recreateRunMock).toHaveBeenCalledTimes(1)
		expect(recreatedSource).toMatchObject({
			...existingRow,
			published_commit: null,
			indexed_commit: null,
		})
		expect(recreatedSource.bootstrapAccess).toEqual({
			defaultBranch: 'main',
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-package-1.git',
			token: 'art_v1_create?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		})
	} finally {
		recreateFetchMock.mockRestore()
	}

	const reuseRunMock = vi.fn()
	const reuseDb = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async first() {
							if (query.includes('FROM entity_sources')) {
								return existingRow
							}
							return null
						},
						run: reuseRunMock,
					}
				},
			}
		},
	} as unknown as D1Database

	const reuseFetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			if (
				method === 'GET' &&
				url.pathname.endsWith('/repos/package-package-1')
			) {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'repo-1',
							name: 'package-package-1',
							description: null,
							default_branch: 'main',
							created_at: '2026-04-18T00:00:00.000Z',
							updated_at: '2026-04-18T00:00:00.000Z',
							last_push_at: null,
							source: null,
							read_only: false,
							remote:
								'https://acct.artifacts.cloudflare.net/git/default/package-package-1.git',
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

	try {
		mocks.waitUntil.mockClear()
		const reusedSource = await ensureEntitySource({
			db: reuseDb,
			env: {
				APP_DB: reuseDb,
				CLOUDFLARE_ACCOUNT_ID: 'acct',
				CLOUDFLARE_API_TOKEN: 'token-123',
				CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
			} as Env,
			userId: 'user-1',
			entityKind: 'package',
			entityId: 'package-1',
			sourceRoot: '/',
		})

		expect(reuseFetchMock).toHaveBeenCalledTimes(1)
		expect(reuseRunMock).not.toHaveBeenCalled()
		expect(reusedSource).toEqual(existingRow)
		expect(reusedSource.bootstrapAccess).toBeUndefined()
		expect(mocks.waitUntil).toHaveBeenCalledTimes(0)
	} finally {
		reuseFetchMock.mockRestore()
	}
})
