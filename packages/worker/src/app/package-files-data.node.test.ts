import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as authenticatedUser from '#app/authenticated-user.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type * as highlightCode from '#app/highlight-code.ts'
import type * as profileRepo from '#worker/community/profile-repo.ts'
import { type UserSocialRow } from '#worker/community/profile-repo.ts'
import type * as communityRepo from '#worker/community/repo.ts'
import type * as communitySnapshot from '#worker/community/snapshot.ts'
import {
	type CommunityListingRecord,
	type CommunitySnapshot,
	type ProfileVisibility,
} from '#worker/community/types.ts'
import type * as publishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type PublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as artifactFile from '#worker/repo/artifact-file.ts'
import type * as artifactHeadCache from '#worker/repo/artifact-head-cache.ts'
import type * as entitySources from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingById:
		vi.fn<typeof communityRepo.getCommunityListingById>(),
	getEntitySourceById: vi.fn<typeof entitySources.getEntitySourceById>(),
	resolveArtifactSourceHead:
		vi.fn<typeof artifactHeadCache.resolveCachedArtifactSourceHead>(),
	readPublishedSourceSnapshot:
		vi.fn<typeof publishedRuntimeArtifacts.readPublishedSourceSnapshot>(),
	readCommunitySnapshot:
		vi.fn<typeof communitySnapshot.readCommunitySnapshot>(),
	readAuthenticatedAppUser:
		vi.fn<typeof authenticatedUser.readAuthenticatedAppUser>(),
	highlightMarkdownFences: vi.fn<typeof highlightCode.highlightMarkdownFences>(
		async () => [],
	),
	highlightSnippets: vi.fn<typeof highlightCode.highlightSnippets>(
		async () => [],
	),
	readArtifactFileAtCommit:
		vi.fn<typeof artifactFile.readArtifactFileAtCommit>(),
	getUserSocialRowByUsername:
		vi.fn<typeof profileRepo.getUserSocialRowByUsername>(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (
		...args: Parameters<typeof communityRepo.getCommunityListingById>
	) => mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (
		...args: Parameters<typeof profileRepo.getUserSocialRowByUsername>
	) => mockModule.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (
		...args: Parameters<typeof entitySources.getEntitySourceById>
	) => mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: (
		...args: Parameters<
			typeof artifactHeadCache.resolveCachedArtifactSourceHead
		>
	) => mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: async () => null,
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (
		...args: Parameters<
			typeof publishedRuntimeArtifacts.readPublishedSourceSnapshot
		>
	) => mockModule.readPublishedSourceSnapshot(...args),
}))

vi.mock('#worker/community/snapshot.ts', () => ({
	readCommunitySnapshot: (
		...args: Parameters<typeof communitySnapshot.readCommunitySnapshot>
	) => mockModule.readCommunitySnapshot(...args),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/highlight-code.ts', () => ({
	highlightMarkdownFences: (
		...args: Parameters<typeof highlightCode.highlightMarkdownFences>
	) => mockModule.highlightMarkdownFences(...args),
	highlightSnippets: (
		...args: Parameters<typeof highlightCode.highlightSnippets>
	) => mockModule.highlightSnippets(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: (
		...args: Parameters<typeof artifactFile.readArtifactFileAtCommit>
	) => mockModule.readArtifactFileAtCommit(...args),
}))

const {
	loadCommunityPackageFileRaw,
	loadCommunityPackageFilesData,
	loadPackagePageHasAgentsDocs,
	resolvePackagePageReadmeImageBaseHref,
} = await import('./package-files-data.ts')

const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env
const listing: CommunityListingRecord = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-1'),
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'sentry',
	name: '@kentcdodds/sentry',
	description: 'Sentry package',
	tags: [],
	category: 'other',
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	iconCommit: 'abc123',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
}

function ownerSocialRow(profileVisibility: ProfileVisibility): UserSocialRow {
	return {
		id: 1,
		username: 'kentcdodds',
		email: 'owner@example.com',
		stable_user_id: 'owner-1',
		display_name: null,
		bio: null,
		avatar_key: null,
		profile_visibility: profileVisibility,
		created_at: '2026-01-01T00:00:00.000Z',
	}
}

const entitySource: EntitySourceRow = {
	id: 'src-1',
	user_id: ownerIdFromStored('owner-1'),
	entity_kind: 'package',
	entity_id: 'pkg-1',
	repo_id: 'repo-1',
	published_commit: 'abc123',
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

function publishedSnapshot(
	files: Record<string, string>,
): PublishedSourceSnapshot {
	return {
		version: 1,
		sourceId: 'src-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'pkg-1',
		publishedCommit: 'abc123',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files,
		createdAt: '2026-01-01T00:00:00.000Z',
	}
}

function communitySnapshotWithFiles(
	files: Record<string, string>,
): CommunitySnapshot {
	return {
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'abc123',
		files,
		createdAt: '2026-01-01T00:00:00.000Z',
	}
}

function viewer(userId: string): AuthenticatedAppUser {
	return {
		sessionUserId: '42',
		userId: 42,
		username: 'viewer',
		email: 'viewer@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'viewer',
		roles: [],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored(userId),
			email: 'viewer@example.com',
			username: 'viewer',
			displayName: 'viewer',
		},
		request: sessionRequestContext(userId),
	}
}

const pngBytes = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
])
const png = String.fromCharCode(...pngBytes)

function publishListing({
	files = { 'README.md': '# Sentry\n' } as Record<string, string> | null,
	headCommit = 'abc123',
	viewerUserId = null as string | null,
	profileVisibility = 'public' as ProfileVisibility,
} = {}) {
	mockModule.getCommunityListingById.mockResolvedValue(listing)
	mockModule.getUserSocialRowByUsername.mockResolvedValue(
		ownerSocialRow(profileVisibility),
	)
	mockModule.getEntitySourceById.mockResolvedValue(entitySource)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: headCommit,
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(
		files && publishedSnapshot(files),
	)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		viewerUserId ? viewer(viewerUserId) : null,
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
	const cases: Array<{ files: Record<string, string>; expected: boolean }> = [
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
		mockModule.readCommunitySnapshot.mockResolvedValue(
			communitySnapshotWithFiles(files),
		)
		const hasAgentsDocs = await loadPackagePageHasAgentsDocs({
			env,
			request: new Request('https://example.com/@kentcdodds/sentry'),
			listingId: 'listing-1',
			viewerIsOwner: false,
		})
		expect({ files, hasAgentsDocs }).toEqual({
			files,
			hasAgentsDocs: expected,
		})
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
	mockModule.readCommunitySnapshot.mockResolvedValue(
		communitySnapshotWithFiles({ 'logo.png': png }),
	)
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
