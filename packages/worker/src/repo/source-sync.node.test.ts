import { expect, test, vi } from 'vitest'
import type * as PublishLock from '#worker/package-registry/package-publish-lock.ts'
import { type ArtifactBootstrapAccess } from './artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(async () => true),
	repoSessionRpc: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
	loadLockedSavedPackage: vi.fn(async () => null),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('./repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writePublishedSourceSnapshot(...args),
}))

vi.mock(
	'#worker/package-registry/package-publish-lock.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PublishLock>()
		return {
			...actual,
			loadLockedSavedPackage: (...args: Array<unknown>) =>
				mockModule.loadLockedSavedPackage(...args),
		}
	},
)

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

const packageJson =
	'{"name":"@scope/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"}}'

const syncInput = {
	env: {
		APP_DB: { prepare: () => ({}) as D1PreparedStatement },
		BUNDLE_ARTIFACTS_KV: {},
		REPO_SESSION: {},
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
	} as unknown as Env,
	userId: 'user-1',
	baseUrl: 'https://heykody.dev',
	sourceId: 'source-1',
}

function sourceRow(overrides: Record<string, unknown> = {}) {
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
		...overrides,
	}
}

const packageSource = {
	entity_kind: 'package',
	entity_id: 'package-1',
	repo_id: 'package-1',
	manifest_path: 'package.json',
}

function bootstrapped(publishedCommit: string, extra = {}) {
	return vi.fn(async () => ({
		sessionId: 'source-sync-source-1-session',
		publishedCommit,
		message: 'Bootstrapped source source-1.',
		...extra,
	}))
}

function publishingSession(publishedCommit: string) {
	return {
		openSession: vi.fn(async () => ({ id: 'source-sync-source-1-session' })),
		applyEdits: vi.fn(async () => ({
			dryRun: false,
			totalChanged: 1,
			edits: [],
		})),
		publishSession: vi.fn(async () => ({
			status: 'ok' as const,
			sessionId: 'source-sync-source-1-session',
			publishedCommit,
			message: 'Published session',
		})),
	}
}

function setupSync(
	row: Record<string, unknown>,
	overrides: Record<string, ReturnType<typeof vi.fn>> = {},
) {
	vi.clearAllMocks()
	const client = {
		bootstrapSource: vi.fn(),
		openSession: vi.fn(),
		applyEdits: vi.fn(),
		publishSession: vi.fn(),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: false,
		})),
		...overrides,
	}
	mockModule.getEntitySourceById.mockResolvedValueOnce(row)
	mockModule.repoSessionRpc.mockReturnValueOnce(client as never)
	return client
}

test('syncArtifactSourceSnapshot bootstraps new sources and uses repo sessions for published sources', async () => {
	const bootstrap = setupSync(sourceRow(), {
		bootstrapSource: bootstrapped('commit-bootstrap-1'),
	})
	await expect(
		syncArtifactSourceSnapshot({ ...syncInput, files: jobFiles }),
	).resolves.toBe('commit-bootstrap-1')
	expect(bootstrap.bootstrapSource).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		edits: [
			{ kind: 'write', path: 'kody.json', content: jobFiles['kody.json'] },
			{ kind: 'write', path: 'src/job.ts', content: jobFiles['src/job.ts'] },
		],
		bootstrapAccess: null,
	})
	expect(bootstrap.openSession).not.toHaveBeenCalled()
	expect(bootstrap.publishSession).not.toHaveBeenCalled()

	const withAccess = setupSync(sourceRow(), {
		bootstrapSource: bootstrapped('commit-bootstrap-2'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			bootstrapAccess,
			files: { 'kody.json': jobFiles['kody.json'] },
		}),
	).resolves.toBe('commit-bootstrap-2')
	expect(withAccess.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({ bootstrapAccess }),
	)

	const session = setupSync(
		sourceRow({
			published_commit: 'commit-existing-1',
			indexed_commit: 'commit-existing-1',
		}),
		{
			...publishingSession('commit-session-2'),
			discardSession: vi.fn(async () => ({
				ok: true as const,
				sessionId: 'source-sync-source-1-session',
				deleted: true,
			})),
		},
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'kody.json': jobFiles['kody.json'] },
		}),
	).resolves.toBe('commit-session-2')
	expect(session.bootstrapSource).not.toHaveBeenCalled()
	expect(session.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
			sourceRoot: '/',
		}),
	)
	expect(session.applyEdits).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			dryRun: false,
			rollbackOnError: true,
		}),
	)
	expect(session.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
		force: true,
	})
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(session.discardSession).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'user-1' }),
	)
})

test('syncArtifactSourceSnapshot refuses to bootstrap a locked package without allowLockedPublish', async () => {
	const locked = setupSync(sourceRow(packageSource))
	mockModule.loadLockedSavedPackage.mockResolvedValue({
		id: 'package-1',
		name: '@scope/demo',
		lockedAt: '2026-08-28T12:00:00.000Z',
	} as never)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'package.json': packageJson },
		}),
	).rejects.toThrow(
		'Package "@scope/demo" is locked. Unlock it on the website before the first published snapshot can be created.',
	)
	expect(locked.bootstrapSource).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	const allowed = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-bootstrap-locked'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			allowLockedPublish: true,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-bootstrap-locked')
	expect(allowed.bootstrapSource).toHaveBeenCalled()
	expect(mockModule.loadLockedSavedPackage).not.toHaveBeenCalled()
})

test('syncArtifactSourceSnapshot first-publishes a forked dest HEAD without force overwrite', async () => {
	const destWorkspaceFiles = {
		'package.json':
			'{"name":"@jane/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"},"private":true}',
		'src/index.ts': 'export const ready = true\n',
		'README.md': 'forked dest tree',
	}
	const forkInput = {
		...syncInput,
		existingHeadCommit: 'commit-dest-head',
		files: { 'package.json': destWorkspaceFiles['package.json'] },
	}

	const fork = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-fork-rewrite', {
			files: destWorkspaceFiles,
		}),
	})
	await expect(syncArtifactSourceSnapshot(forkInput)).resolves.toBe(
		'commit-fork-rewrite',
	)
	expect(fork.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({
			existingHeadCommit: 'commit-dest-head',
			edits: [expect.objectContaining({ kind: 'write', path: 'package.json' })],
		}),
	)
	expect(fork.openSession).not.toHaveBeenCalled()
	expect(fork.publishSession).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: destWorkspaceFiles,
			source: expect.objectContaining({
				published_commit: 'commit-fork-rewrite',
			}),
		}),
	)

	setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-fork-rewrite'),
	})
	await expect(syncArtifactSourceSnapshot(forkInput)).rejects.toThrow(
		/produced no workspace snapshot/,
	)
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()

	const published = setupSync(
		sourceRow({ ...packageSource, published_commit: 'commit-existing-1' }),
	)
	await expect(syncArtifactSourceSnapshot(forkInput)).rejects.toThrow(
		/already has a published commit/,
	)
	expect(published.bootstrapSource).not.toHaveBeenCalled()
	expect(published.publishSession).not.toHaveBeenCalled()
})
