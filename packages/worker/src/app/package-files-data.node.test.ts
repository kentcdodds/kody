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
	readArtifactFileAtCommit: vi.fn<() => Promise<unknown>>(),
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

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactFileAtCommit(...args),
}))

const {
	loadCommunityPackageFileRaw,
	loadCommunityPackageFilesData,
	loadPackagePageHasAgentsDocs,
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

test('opens a png as a media preview and an unknown binary without a code dump', async () => {
	const pngBytes = Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
	])
	const png = String.fromCharCode(...pngBytes)
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
		files: {
			'README.md': '# Sentry\n',
			'logo.png': png,
			'app.wasm': 'wasm\0module',
		},
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.readArtifactFileAtCommit.mockResolvedValue(pngBytes)

	const image = await loadCommunityPackageFilesData({
		env,
		request: new Request(
			'https://example.com/@kentcdodds/sentry/tree/main/logo.png',
		),
		listingId: 'listing-1',
		selectedPath: 'logo.png',
		ref: 'main',
	})
	expect(image).toMatchObject({
		ok: true,
		content: null,
		contentKind: 'image',
		mediaHref: '/@kentcdodds/sentry/raw/main/logo.png',
		contentByteLength: pngBytes.byteLength,
	})
	expect(image?.content).toBeNull()
	expect(mockModule.highlightSnippets).not.toHaveBeenCalled()

	const binary = await loadCommunityPackageFilesData({
		env,
		request: new Request(
			'https://example.com/@kentcdodds/sentry/tree/main/app.wasm',
		),
		listingId: 'listing-1',
		selectedPath: 'app.wasm',
		ref: 'main',
	})
	expect(binary).toMatchObject({
		content: null,
		contentKind: 'binary',
		mediaHref: null,
	})
	expect(binary?.content).toBeNull()

	const raw = await loadCommunityPackageFileRaw({
		env,
		request: new Request(
			'https://example.com/@kentcdodds/sentry/raw/main/logo.png',
		),
		listingId: 'listing-1',
		selectedPath: 'logo.png',
		ref: 'main',
	})
	expect(raw).toEqual({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		filename: 'logo.png',
		isPrivate: false,
	})

	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>'),
	)
	expect(
		await loadCommunityPackageFileRaw({
			env,
			request: new Request(
				'https://example.com/@kentcdodds/sentry/raw/main/logo.png',
			),
			listingId: 'listing-1',
			selectedPath: 'logo.png',
			ref: 'main',
		}),
	).toEqual({ kind: 'not-media' })
})
