import { expect, test, vi } from 'vitest'
import { type ArtifactBootstrapAccess } from './artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(async () => true),
	repoSessionRpc: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('./repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writePublishedSourceSnapshot(...args),
}))

const { syncArtifactSourceSnapshot } = await import('./source-sync.ts')

const bootstrapAccess: ArtifactBootstrapAccess = {
	defaultBranch: 'main',
	remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
	token: 'art_v1_bootstrap?expires=1760000000',
	expiresAt: '2025-10-09T08:53:20.000Z',
}

function createBundleArtifactsKv(): KVNamespace {
	const store = new Map<string, string>()
	return {
		async get(key: string, type?: 'text' | 'json') {
			const value = store.get(key) ?? null
			if (value == null) return null
			if (type === 'json') {
				return JSON.parse(value)
			}
			return value
		},
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
			if (typeof value === 'string') {
				store.set(key, value)
				return
			}
			const view =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
			store.set(key, Buffer.from(view).toString('utf8'))
		},
		async delete(key: string) {
			store.delete(key)
		},
	} as unknown as KVNamespace
}

test('syncArtifactSourceSnapshot bootstraps unpublished sources directly into the source repo', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.repoSessionRpc.mockReset()

	const sessionClient = {
		bootstrapSource: vi.fn(async () => ({
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-bootstrap-1',
			message: 'Bootstrapped source source-1 in app-1.',
		})),
		openSession: vi.fn(),
		applyEdits: vi.fn(),
		publishSession: vi.fn(),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: false,
		})),
	}

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'app',
		entity_id: 'app-1',
		repo_id: 'app-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)

	const publishedCommit = await syncArtifactSourceSnapshot({
		env: {
			APP_DB: {
				prepare() {
					return {} as D1PreparedStatement
				},
			},
			BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
			REPO_SESSION: {},
			CLOUDFLARE_ACCOUNT_ID: 'account-1',
			CLOUDFLARE_API_TOKEN: 'token-1',
		} as unknown as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceId: 'source-1',
		files: {
			'kody.json': '{"version":1,"kind":"app"}',
			'client.html': '<main>Hello</main>',
		},
	})

	expect(publishedCommit).toBe('commit-bootstrap-1')
	expect(sessionClient.bootstrapSource).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'kody.json',
				content: '{"version":1,"kind":"app"}',
			},
			{
				kind: 'write',
				path: 'client.html',
				content: '<main>Hello</main>',
			},
		],
		bootstrapAccess: null,
	})
	expect(sessionClient.openSession).not.toHaveBeenCalled()
	expect(sessionClient.applyEdits).not.toHaveBeenCalled()
	expect(sessionClient.publishSession).not.toHaveBeenCalled()
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
	})
})

test('syncArtifactSourceSnapshot still uses repo sessions for already-published sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.repoSessionRpc.mockReset()

	const sessionClient = {
		bootstrapSource: vi.fn(),
		openSession: vi.fn(async () => ({
			id: 'source-sync-source-1-session',
		})),
		applyEdits: vi.fn(async () => ({
			dryRun: false,
			totalChanged: 1,
			edits: [],
		})),
		publishSession: vi.fn(async () => ({
			status: 'ok' as const,
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-session-2',
			message: 'Published session source-sync-source-1-session to app-1.',
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: true,
		})),
	}

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'app',
		entity_id: 'app-1',
		repo_id: 'app-1',
		published_commit: 'commit-existing-1',
		indexed_commit: 'commit-existing-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)

	const publishedCommit = await syncArtifactSourceSnapshot({
		env: {
			APP_DB: {
				prepare() {
					return {} as D1PreparedStatement
				},
			},
			BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
			REPO_SESSION: {},
			CLOUDFLARE_ACCOUNT_ID: 'account-1',
			CLOUDFLARE_API_TOKEN: 'token-1',
		} as unknown as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceId: 'source-1',
		files: {
			'kody.json': '{"version":1,"kind":"app"}',
		},
	})

	expect(publishedCommit).toBe('commit-session-2')
	expect(sessionClient.bootstrapSource).not.toHaveBeenCalled()
	expect(sessionClient.openSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceRoot: '/',
	})
	expect(sessionClient.applyEdits).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'kody.json',
				content: '{"version":1,"kind":"app"}',
			},
		],
		dryRun: false,
		rollbackOnError: true,
	})
	expect(sessionClient.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
		force: true,
	})
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
	})
})

test('syncArtifactSourceSnapshot forwards bootstrap access for the first publish of a new source', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.repoSessionRpc.mockReset()

	const sessionClient = {
		bootstrapSource: vi.fn(async () => ({
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-bootstrap-2',
			message: 'Bootstrapped source source-1 in app-1.',
		})),
		openSession: vi.fn(),
		applyEdits: vi.fn(),
		publishSession: vi.fn(),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: false,
		})),
	}

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'skill',
		entity_id: 'skill-1',
		repo_id: 'skill-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)

	const publishedCommit = await syncArtifactSourceSnapshot({
		env: {
			APP_DB: {
				prepare() {
					return {} as D1PreparedStatement
				},
			},
			BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
			REPO_SESSION: {},
			CLOUDFLARE_ACCOUNT_ID: 'account-1',
			CLOUDFLARE_API_TOKEN: 'token-1',
		} as unknown as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceId: 'source-1',
		bootstrapAccess,
		files: {
			'kody.json': '{"version":1,"kind":"skill"}',
		},
	})

	expect(publishedCommit).toBe('commit-bootstrap-2')
	expect(sessionClient.bootstrapSource).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'kody.json',
				content: '{"version":1,"kind":"skill"}',
			},
		],
		bootstrapAccess,
	})
	expect(sessionClient.openSession).not.toHaveBeenCalled()
})

test('syncArtifactSourceSnapshot restores the previous published commit when snapshot persistence fails after publish', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.writePublishedSourceSnapshot.mockReset()

	const sessionClient = {
		bootstrapSource: vi.fn(),
		openSession: vi.fn(async () => ({
			id: 'source-sync-source-1-session',
		})),
		applyEdits: vi.fn(async () => ({
			dryRun: false,
			totalChanged: 1,
			edits: [],
		})),
		publishSession: vi.fn(async () => ({
			status: 'ok' as const,
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-session-rollback',
			message: 'Published session source-sync-source-1-session to app-1.',
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: true,
		})),
	}

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'app',
		entity_id: 'app-1',
		repo_id: 'app-1',
		published_commit: 'commit-existing-1',
		indexed_commit: 'commit-existing-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)
	mockModule.writePublishedSourceSnapshot.mockRejectedValueOnce(
		new Error('kv write failed'),
	)

	await expect(
		syncArtifactSourceSnapshot({
			env: {
				APP_DB: {
					prepare() {
						return {} as D1PreparedStatement
					},
				},
				BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
				REPO_SESSION: {},
				CLOUDFLARE_ACCOUNT_ID: 'account-1',
				CLOUDFLARE_API_TOKEN: 'token-1',
			} as unknown as Env,
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			sourceId: 'source-1',
			files: {
				'kody.json': '{"version":1,"kind":"app"}',
			},
		}),
	).rejects.toThrow('kv write failed')

	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-existing-1',
		}),
	)
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
	})
})
