import { expect, test } from 'vitest'

const {
	createArtifactsRepoIfMissing,
	ensureEntitySource,
} = await import('./source-service.ts')

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

test('createArtifactsRepoIfMissing waits for pending repos to become ready after create', async () => {
	let getCount = 0
	const readyRepo = {
		async info() {
			return null
		},
		async createToken() {
			throw new Error('Not implemented in test')
		},
		async fork() {
			throw new Error('Not implemented in test')
		},
	}
	const binding = {
		async get(name: string) {
			getCount += 1
			if (getCount === 1) {
				return { status: 'not_found' as const }
			}
			if (getCount === 2) {
				return { status: 'importing' as const, retryAfter: 0 }
			}
			return { status: 'ready' as const, repo: readyRepo }
		},
		async create(name: string) {
			return {
				id: 'repo_1',
				name,
				description: null,
				defaultBranch: 'main',
				remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
				token: 'art_v1_create?expires=1760000000',
				expiresAt: '2026-10-09T08:53:20.000Z',
			}
		},
		async list() {
			return { repos: [], total: 0 }
		},
	}

	await expect(
		createArtifactsRepoIfMissing({} as Env, 'repo-1', binding),
	).resolves.toBe(readyRepo)
})
