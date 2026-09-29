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
	getUserSocialRowByUsername: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
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
	resolvePackagePageReadmeImageBaseHref,
} = await import('./package-files-data.ts')

const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env
const listing = {
	id: 'listing-1',
	ownerUserId: 'owner-1',
	sourceId: 'src-1',
	kodyId: 'sentry',
	name: '@kentcdodds/sentry',
	description: 'Sentry package',
	pinnedCommit: 'abc123',
	iconCommit: 'abc123',
}
const pngBytes = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
])
const png = String.fromCharCode(...pngBytes)

function publishListing({
	files = { 'README.md': '# Sentry\n' } as Record<string, string> | null,
	headCommit = 'abc123',
	viewerUserId = null as string | null,
	profileVisibility = 'public',
} = {}) {
	mockModule.getCommunityListingById.mockResolvedValue(listing)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: profileVisibility,
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		repo_id: 'repo-1',
		published_commit: 'abc123',
	})
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: headCommit,
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(files && { files })
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		viewerUserId && { mcpUser: { userId: viewerUserId } },
	)
}

function loadTree(selectedPath = '', ref = 'main') {
	return loadCommunityPackageFilesData({
		env,
		request: new Request(
			`https://example.com/@kentcdodds/sentry/tree/${ref}/${selectedPath}`,
		),
		listingId: 'listing-1',
		selectedPath,
		ref,
	})
}

function loadRaw(selectedPath: string, ref = 'main') {
	return loadCommunityPackageFileRaw({
		env,
		request: new Request(
			`https://example.com/@kentcdodds/sentry/raw/${ref}/${selectedPath}`,
		),
		listingId: 'listing-1',
		selectedPath,
		ref,
	})
}

test('listed package tree chrome marks the owner, links only a public owner profile, and serves README images only at the pin', async () => {
	publishListing({ viewerUserId: 'owner-1' })
	expect(await loadTree()).toMatchObject({
		ok: true,
		username: 'kentcdodds',
		kodyId: 'sentry',
		viewerIsOwner: true,
		isPrivate: false,
		backHref: '/@kentcdodds/sentry',
		filesBasePath: '/@kentcdodds/sentry/tree/main',
		imageBaseHref: '/@kentcdodds/sentry/assets',
		iconUrl: '/community/listing-1/icon/abc123',
		description: 'Sentry package',
		ownerProfilePublic: true,
	})

	publishListing({ profileVisibility: 'private' })
	expect(await loadTree()).toMatchObject({
		ok: true,
		viewerIsOwner: false,
		username: 'kentcdodds',
		kodyId: 'sentry',
		description: 'Sentry package',
		ownerProfilePublic: false,
	})

	publishListing({
		headCommit: 'deadbeef',
		files: { 'README.md': '![poster](./docs/poster.png)\n' },
	})
	expect(await loadTree()).toMatchObject({ ok: true, imageBaseHref: null })
})

test('package page reports AGENTS.md only when a non-empty root file exists', async () => {
	const cases = [
		{ files: { 'README.md': '# Sentry\n' }, expected: false },
		{
			files: {
				'README.md': '# Sentry\n',
				'AGENTS.md': '# Agents\n\nImport the root export.\n',
			},
			expected: true,
		},
		{ files: { 'docs/AGENTS.md': 'Nested only.\n' }, expected: false },
	]
	for (const { files, expected } of cases) {
		mockModule.readCommunitySnapshot.mockResolvedValue({ files })
		const hasAgentsDocs = await loadPackagePageHasAgentsDocs({
			env,
			request: new Request('https://example.com/@kentcdodds/sentry'),
			listingId: 'listing-1',
			viewerIsOwner: false,
		})
		expect({ files, hasAgentsDocs }).toEqual({ files, hasAgentsDocs: expected })
	}
})

test('package page README images opt in for listing README and only matching owner commits', () => {
	const cases = [
		{
			usedListingReadme: true,
			publishedCommit: 'published-ahead',
			expected: '/@kentcdodds/sentry/assets',
		},
		{
			usedListingReadme: false,
			publishedCommit: 'published-ahead',
			expected: null,
		},
		{
			usedListingReadme: false,
			publishedCommit: 'abc123',
			expected: '/@kentcdodds/sentry/assets',
		},
	]
	for (const { expected, ...input } of cases) {
		const href = resolvePackagePageReadmeImageBaseHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'sentry',
			pinnedCommit: 'abc123',
			...input,
		})
		expect({ ...input, href }).toEqual({ ...input, href: expected })
	}
})

test('opens a png as a media preview and an unknown binary without a code dump', async () => {
	publishListing({
		files: {
			'README.md': '# Sentry\n',
			'logo.png': png,
			'app.wasm': 'wasm\0module',
		},
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(pngBytes)

	expect(await loadTree('logo.png')).toMatchObject({
		ok: true,
		content: null,
		contentKind: 'image',
		mediaHref: '/@kentcdodds/sentry/raw/main/logo.png',
		contentByteLength: pngBytes.byteLength,
	})
	expect(mockModule.highlightSnippets).not.toHaveBeenCalled()
	expect(await loadTree('app.wasm')).toMatchObject({
		content: null,
		contentKind: 'binary',
		mediaHref: null,
	})
	expect(await loadRaw('logo.png')).toEqual({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		filename: 'logo.png',
		isPrivate: false,
	})

	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>'),
	)
	expect(await loadRaw('logo.png')).toEqual({ kind: 'not-media' })
})

test('community raw 404s a hex that only has the listing pin snapshot', async () => {
	const missingHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
	publishListing({ files: null })
	mockModule.readCommunitySnapshot.mockResolvedValue({
		files: { 'logo.png': png },
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(null)

	expect(await loadTree('logo.png', missingHex)).toBeNull()
	expect(await loadRaw('logo.png', missingHex)).toEqual({ kind: 'not-found' })
	const pinRaw = await loadRaw('logo.png', 'abc123')
	expect(pinRaw).toMatchObject({
		kind: 'ok',
		contentType: 'image/png',
		filename: 'logo.png',
		isPrivate: false,
	})
	expect(pinRaw.kind === 'ok' && [...pinRaw.bytes]).toEqual([...pngBytes])
})
