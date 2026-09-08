import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getCommunityListingById: vi.fn<() => Promise<unknown>>(),
	getEntitySourceById: vi.fn<() => Promise<unknown>>(),
	resolveArtifactSourceHead: vi.fn<() => Promise<unknown>>(),
	readPublishedSourceSnapshot: vi.fn<() => Promise<unknown>>(),
	readCommunitySnapshot: vi.fn<() => Promise<unknown>>(),
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

vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: async () => null,
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.readPublishedSourceSnapshot(...args),
}))

vi.mock('#worker/community/snapshot.ts', () => ({
	readCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.readCommunitySnapshot(...args),
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

const {
	loadCommunityPackageFilesData,
	loadPackagePageHasAgentsDocs,
	resolvePackagePageReadmeImageBaseHref,
} = await import('./package-files-data.ts')

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
		imageBaseHref: '/@kentcdodds/sentry/assets',
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

test('listed package tree omits imageBaseHref when HEAD is not the pin', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(listing)
	mockModule.getEntitySourceById.mockResolvedValue({
		repo_id: 'repo-1',
		published_commit: 'abc123',
	})
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'deadbeef',
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue({
		files: { 'README.md': '![poster](./docs/poster.png)\n' },
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)

	const ahead = await loadCommunityPackageFilesData({
		env,
		request: new Request('https://example.com/@kentcdodds/sentry/tree/main'),
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'main',
	})
	expect(ahead).toMatchObject({
		ok: true,
		imageBaseHref: null,
	})
})

test('package page reports AGENTS.md only when a non-empty root file exists', async () => {
	mockModule.readCommunitySnapshot.mockResolvedValue({
		files: { 'README.md': '# Sentry\n' },
	})
	expect(
		await loadPackagePageHasAgentsDocs({
			env,
			request: new Request('https://example.com/@kentcdodds/sentry'),
			listingId: 'listing-1',
			viewerIsOwner: false,
		}),
	).toBe(false)

	mockModule.readCommunitySnapshot.mockResolvedValue({
		files: {
			'README.md': '# Sentry\n',
			'AGENTS.md': '# Agents\n\nImport the root export.\n',
		},
	})
	expect(
		await loadPackagePageHasAgentsDocs({
			env,
			request: new Request('https://example.com/@kentcdodds/sentry'),
			listingId: 'listing-1',
			viewerIsOwner: false,
		}),
	).toBe(true)

	mockModule.readCommunitySnapshot.mockResolvedValue({
		files: { 'docs/AGENTS.md': 'Nested only.\n' },
	})
	expect(
		await loadPackagePageHasAgentsDocs({
			env,
			request: new Request('https://example.com/@kentcdodds/sentry'),
			listingId: 'listing-1',
			viewerIsOwner: false,
		}),
	).toBe(false)
})

test('package page README images follow the pin, not unpublished HEAD', async () => {
	const request = new Request('https://example.com/@kentcdodds/sentry')
	expect(
		await resolvePackagePageReadmeImageBaseHref({
			env,
			request,
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'sentry',
			usedListingReadme: true,
			sourceId: 'src-1',
			publishedCommit: 'abc123',
		}),
	).toBe('/@kentcdodds/sentry/assets')

	mockModule.getEntitySourceById.mockResolvedValue({ repo_id: 'repo-1' })
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'abc123',
	})
	expect(
		await resolvePackagePageReadmeImageBaseHref({
			env,
			request,
			ownerUsername: 'kentcdodds',
			kodyId: 'sentry',
			usedListingReadme: false,
			sourceId: 'src-1',
			publishedCommit: 'abc123',
		}),
	).toBe('/@kentcdodds/sentry/assets')

	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'deadbeef',
	})
	expect(
		await resolvePackagePageReadmeImageBaseHref({
			env,
			request,
			ownerUsername: 'kentcdodds',
			kodyId: 'sentry',
			usedListingReadme: false,
			sourceId: 'src-1',
			publishedCommit: 'abc123',
		}),
	).toBe(null)
})
