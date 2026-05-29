import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	resolveOwnedPackageSource: vi.fn(),
	readPublishGitNoteFromArtifactsRepo: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#mcp/capabilities/packages/resolve-package-source.ts', () => ({
	resolveOwnedPackageSource: (...args: Array<unknown>) =>
		mockModule.resolveOwnedPackageSource(...args),
}))

vi.mock('#worker/repo/publish-git-notes.ts', async () => {
	const actual = await vi.importActual('#worker/repo/publish-git-notes.ts')
	return {
		...(actual as object),
		readPublishGitNoteFromArtifactsRepo: (...args: Array<unknown>) =>
			mockModule.readPublishGitNoteFromArtifactsRepo(...args),
	}
})

const { repoShowPublishNoteCapability } =
	await import('./repo-show-publish-note.ts')

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
}

function createContext(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: `${userId}@example.com`,
				displayName: userId,
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

const sampleSource = {
	id: 'source-1',
	user_id: 'user-1',
	entity_kind: 'package' as const,
	entity_id: 'package-1',
	repo_id: 'package-package-1',
	published_commit: 'commit-published',
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	created_at: '2026-05-28T00:00:00.000Z',
	updated_at: '2026-05-28T00:00:00.000Z',
}

const sampleNote = {
	v: 1 as const,
	publishedAt: '2026-05-28T12:00:00.000Z',
	publishedBy: 'repo_session' as const,
	sourceId: 'source-1',
	entityKind: 'package' as const,
	entityId: 'package-1',
	repoId: 'package-package-1',
	commit: 'commit-published',
	sessionId: 'session-1',
	conversationId: null,
	previousPublishedCommit: null,
	baseCommit: 'commit-base',
	checks: null,
}

test('repo_show_publish_note reads notes by source or package identity and rejects cross-user access', async () => {
	resetMocks()
	mockModule.getEntitySourceById.mockResolvedValue(sampleSource)
	mockModule.readPublishGitNoteFromArtifactsRepo.mockResolvedValue({
		found: true,
		commit: 'commit-published',
		rawNote: JSON.stringify(sampleNote),
		note: sampleNote,
	})

	const bySource = await repoShowPublishNoteCapability.handler(
		{ source_id: 'source-1' },
		createContext(),
	)

	expect(mockModule.readPublishGitNoteFromArtifactsRepo).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: {} }),
		repoId: 'package-package-1',
		commitOid: 'commit-published',
	})
	expect(bySource.found).toBe(true)
	expect(bySource.note?.publishedBy).toBe('repo_session')

	resetMocks()
	mockModule.resolveOwnedPackageSource.mockResolvedValue({
		packageId: 'package-1',
		kodyId: 'demo',
		name: '@kent/demo',
		source: sampleSource,
	})
	mockModule.readPublishGitNoteFromArtifactsRepo.mockResolvedValue({
		found: false,
		commit: 'commit-old',
		rawNote: null,
		note: null,
	})

	const byPackage = await repoShowPublishNoteCapability.handler(
		{ kody_id: 'demo', commit: 'commit-old' },
		createContext(),
	)

	expect(byPackage.found).toBe(false)
	expect(byPackage.commit).toBe('commit-old')

	resetMocks()
	mockModule.getEntitySourceById.mockResolvedValue({
		...sampleSource,
		user_id: 'other-user',
	})
	await expect(
		repoShowPublishNoteCapability.handler(
			{ source_id: 'source-1' },
			createContext(),
		),
	).rejects.toThrow('Repo source was not found for this user.')
})
