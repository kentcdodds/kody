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

const jobFiles = {
	'kody.json': '{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
	'src/job.ts': 'export default async function main() { return { ok: true } }',
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

function createSyncEnv() {
	return {
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
	}
}

function createUnpublishedSourceRow() {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'job',
		entity_id: 'job-1',
		repo_id: 'job-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
}

function createPublishedSourceRow() {
	return {
		...createUnpublishedSourceRow(),
		published_commit: 'commit-existing-1',
		indexed_commit: 'commit-existing-1',
	}
}

test('syncArtifactSourceSnapshot bootstraps new sources and uses repo sessions for published sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.writePublishedSourceSnapshot.mockReset()

	const bootstrapClient = {
		bootstrapSource: vi.fn(async () => ({
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-bootstrap-1',
			message: 'Bootstrapped source source-1 in job-1.',
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
	mockModule.getEntitySourceById.mockResolvedValueOnce(
		createUnpublishedSourceRow(),
	)
	mockModule.repoSessionRpc.mockReturnValueOnce(bootstrapClient as never)

	const syncInput = createSyncEnv()
	const bootstrapCommit = await syncArtifactSourceSnapshot({
		...syncInput,
		files: jobFiles,
	})

	expect(bootstrapCommit).toBe('commit-bootstrap-1')
	expect(bootstrapClient.bootstrapSource).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'kody.json',
				content: jobFiles['kody.json'],
			},
			{
				kind: 'write',
				path: 'src/job.ts',
				content: jobFiles['src/job.ts'],
			},
		],
		bootstrapAccess: null,
	})
	expect(bootstrapClient.openSession).not.toHaveBeenCalled()
	expect(bootstrapClient.publishSession).not.toHaveBeenCalled()

	mockModule.getEntitySourceById.mockReset()
	mockModule.repoSessionRpc.mockReset()
	const bootstrapAccessClient = {
		...bootstrapClient,
		bootstrapSource: vi.fn(async () => ({
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-bootstrap-2',
			message: 'Bootstrapped source source-1 in job-1.',
		})),
	}
	bootstrapAccessClient.bootstrapSource.mockClear()
	mockModule.getEntitySourceById.mockResolvedValueOnce(
		createUnpublishedSourceRow(),
	)
	mockModule.repoSessionRpc.mockReturnValueOnce(bootstrapAccessClient as never)

	const bootstrapAccessCommit = await syncArtifactSourceSnapshot({
		...syncInput,
		bootstrapAccess,
		files: { 'kody.json': jobFiles['kody.json'] },
	})

	expect(bootstrapAccessCommit).toBe('commit-bootstrap-2')
	expect(bootstrapAccessClient.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({ bootstrapAccess }),
	)

	mockModule.getEntitySourceById.mockReset()
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
			publishedCommit: 'commit-session-2',
			message: 'Published session source-sync-source-1-session to job-1.',
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: true,
		})),
	}
	mockModule.getEntitySourceById.mockResolvedValueOnce(
		createPublishedSourceRow(),
	)
	mockModule.repoSessionRpc.mockReturnValueOnce(sessionClient as never)

	const sessionCommit = await syncArtifactSourceSnapshot({
		...syncInput,
		files: { 'kody.json': jobFiles['kody.json'] },
	})

	expect(sessionCommit).toBe('commit-session-2')
	expect(sessionClient.bootstrapSource).not.toHaveBeenCalled()
	expect(sessionClient.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
			sourceRoot: '/',
		}),
	)
	expect(sessionClient.applyEdits).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			dryRun: false,
			rollbackOnError: true,
		}),
	)
	expect(sessionClient.publishSession).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			force: true,
		}),
	)
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(sessionClient.discardSession).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'user-1' }),
	)
})
