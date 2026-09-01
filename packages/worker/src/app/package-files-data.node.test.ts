import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getCommunityListingById: vi.fn<() => Promise<unknown>>(),
	getEntitySourceById: vi.fn<() => Promise<unknown>>(),
	resolveArtifactSourceHead: vi.fn<() => Promise<unknown>>(),
	readPublishedSourceSnapshot: vi.fn<() => Promise<unknown>>(),
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
	highlightMarkdownFences: vi.fn(async () => []),
	highlightSnippets: vi.fn(async () => []),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
	readMockArtifactSnapshot: async () => null,
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.readPublishedSourceSnapshot(...args),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/highlight-code.ts', () => ({
	highlightMarkdownFences: (...args: Array<unknown>) =>
		mockModule.highlightMarkdownFences(...args),
	highlightSnippets: (...args: Array<unknown>) =>
		mockModule.highlightSnippets(...args),
}))

const { loadCommunityPackageFilesData } =
	await import('./package-files-data.ts')

const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env
const listing = {
	id: 'listing-1',
	ownerUserId: 'owner-1',
	sourceId: 'src-1',
	kodyId: 'sentry',
	name: '@kentcdodds/sentry',
	pinnedCommit: 'abc123',
}

test('listed package tree marks the owner so Settings stays on the chrome', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(listing)
	mockModule.getEntitySourceById.mockResolvedValue({
		repo_id: 'repo-1',
		published_commit: 'abc123',
	})
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'abc123',
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue({
		files: { 'README.md': '# Sentry\n' },
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'owner-1' },
	})

	const ownerRequest = new Request(
		'https://example.com/@kentcdodds/sentry/tree/main',
	)
	const owner = await loadCommunityPackageFilesData({
		env,
		request: ownerRequest,
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'main',
	})
	expect(owner).toMatchObject({
		ok: true,
		username: 'kentcdodds',
		kodyId: 'sentry',
		viewerIsOwner: true,
		isPrivate: false,
		backHref: '/@kentcdodds/sentry',
		filesBasePath: '/@kentcdodds/sentry/tree/main',
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const stranger = await loadCommunityPackageFilesData({
		env,
		request: new Request('https://example.com/@kentcdodds/sentry/tree/main'),
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'main',
	})
	expect(stranger).toMatchObject({
		viewerIsOwner: false,
		username: 'kentcdodds',
		kodyId: 'sentry',
	})
})
