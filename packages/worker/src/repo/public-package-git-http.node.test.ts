import { expect, test, vi } from 'vitest'
import { encodeGitFlushPkt, encodeGitPktLine } from './git-pkt-line.ts'

const resolveCommunityPackageUrl = vi.fn()
const getCommunityListingById = vi.fn()
const getEntitySourceById = vi.fn()
const resolveExistingArtifactSourceRepo = vi.fn()
const checkRateLimit = vi.fn()

vi.mock('#worker/community/package-url.ts', () => ({
	resolveCommunityPackageUrl: (...args: Array<unknown>) =>
		resolveCommunityPackageUrl(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildAuthenticatedArtifactsRemote: ({
		remote,
		token,
	}: {
		remote: string
		token: string
	}) => {
		const url = new URL(remote)
		url.username = 'x'
		url.password = token.split('?expires=')[0] ?? token
		return url.toString()
	},
	parseArtifactTokenSecret: (token: string) =>
		token.split('?expires=')[0] ?? token,
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		resolveExistingArtifactSourceRepo(...args),
}))

vi.mock('#app/rate-limit.ts', () => ({
	checkRateLimit: (...args: Array<unknown>) => checkRateLimit(...args),
}))

vi.mock('#worker/audit-log.ts', () => ({
	getRequestIp: () => '203.0.113.10',
}))

const {
	handlePublicPackageGitHttpRequest,
	parsePublicPackageGitHttpPath,
	resolveImmutableSnapshotCommit,
} = await import('./public-package-git-http.ts')

const publishedCommit = '0123456789abcdef0123456789abcdef01234567'
const liveCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function resetMocks() {
	resolveCommunityPackageUrl.mockReset()
	getCommunityListingById.mockReset()
	getEntitySourceById.mockReset()
	resolveExistingArtifactSourceRepo.mockReset()
	checkRateLimit.mockReset()
	checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: null })
}

function seedPublicListing(input?: {
	username?: string
	kodyId?: string
	publishedCommit?: string | null
	pinnedCommit?: string
}) {
	const username = input?.username ?? 'kody'
	const kodyId = input?.kodyId ?? 'cloudflare'
	resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		username,
		kodyId,
	})
	getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		ownerUserId: 'owner-1',
		packageId: 'pkg-1',
		sourceId: 'source-1',
		kodyId,
		name: `@${username}/${kodyId}`,
		description: 'test',
		tags: [],
		category: 'other',
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: input?.pinnedCommit ?? publishedCommit,
		iconCommit: publishedCommit,
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'active',
	})
	getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'package-pkg-1',
		published_commit:
			input?.publishedCommit === undefined
				? publishedCommit
				: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '.',
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	})
	resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			id: 'repo-1',
			name: 'package-pkg-1',
			description: null,
			defaultBranch: 'main',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote: 'https://artifacts.example.test/git/default/package-pkg-1.git',
		}),
		createToken: async () => ({
			id: 'tok-1',
			plaintext: 'art_v1_secret?expires=9999999999',
			scope: 'read',
			expiresAt: '2099-01-01T00:00:00.000Z',
		}),
	})
}

function envStub() {
	return { APP_DB: {} } as Env
}

test('parsePublicPackageGitHttpPath recognizes smart HTTP suffixes under /@owner/pkg.git', () => {
	expect(parsePublicPackageGitHttpPath('/@kody/cloudflare.git')).toEqual({
		kind: 'repo-root',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare.git/info/refs'),
	).toEqual({
		kind: 'info-refs',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare.git/git-upload-pack'),
	).toEqual({
		kind: 'upload-pack',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare.git/git-receive-pack'),
	).toEqual({
		kind: 'receive-pack',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(parsePublicPackageGitHttpPath('/@kody/cloudflare')).toBeNull()
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare/tree/main'),
	).toBeNull()
})

test('resolveImmutableSnapshotCommit prefers published_commit then pinned_commit', () => {
	expect(
		resolveImmutableSnapshotCommit({
			publishedCommit: publishedCommit,
			pinnedCommit: liveCommit,
		}),
	).toBe(publishedCommit)
	expect(
		resolveImmutableSnapshotCommit({
			publishedCommit: null,
			pinnedCommit: publishedCommit,
		}),
	).toBe(publishedCommit)
	expect(
		resolveImmutableSnapshotCommit({
			publishedCommit: 'short',
			pinnedCommit: 'also-short',
		}),
	).toBeNull()
})

test('public package git HTTP advertises the published snapshot and proxies upload-pack without leaking Artifacts credentials', async () => {
	resetMocks()
	seedPublicListing()

	const upstreamAdvertisement =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(
			`${liveCommit} HEAD\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/artifacts\n`,
		) +
		encodeGitPktLine(`${liveCommit} refs/heads/main\n`) +
		encodeGitPktLine(`${liveCommit} refs/heads/wip\n`) +
		encodeGitFlushPkt()

	const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
		const url = String(input)
		if (url.includes('/info/refs')) {
			expect(url).toContain('artifacts.example.test')
			expect(url).not.toContain('art_v1_secret')
			expect(new Headers(init?.headers).get('Authorization')).toBe(
				'Bearer art_v1_secret',
			)
			return new Response(upstreamAdvertisement, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
				},
			})
		}
		if (url.endsWith('/git-upload-pack')) {
			expect(url).toContain('artifacts.example.test')
			expect(url).not.toContain('art_v1_secret')
			expect(new Headers(init?.headers).get('Authorization')).toBe(
				'Bearer art_v1_secret',
			)
			expect(init?.method).toBe('POST')
			return new Response('PACK-FAKE', {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-result',
					Location: 'https://artifacts.example.test/secret-redirect',
					'WWW-Authenticate': 'Basic realm=artifacts',
					'Set-Cookie': 'artifacts=1',
				},
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	})

	const infoRefs = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
		{ fetchImpl: fetchImpl as unknown as typeof fetch },
	)
	expect(infoRefs).not.toBeNull()
	expect(infoRefs!.status).toBe(200)
	expect(infoRefs!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-advertisement',
	)
	const advertisement = await infoRefs!.text()
	expect(advertisement).toContain(`${publishedCommit} HEAD\0`)
	expect(advertisement).toContain(`${publishedCommit} refs/heads/main\n`)
	expect(advertisement).not.toContain(liveCommit)
	expect(advertisement).not.toContain('refs/heads/wip')
	expect(advertisement).not.toContain('art_v1_secret')
	expect(advertisement).not.toContain('artifacts.example.test')

	const uploadPack = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-git-upload-pack-request',
				Accept: 'application/x-git-upload-pack-result',
				'Git-Protocol': 'version=2',
			},
			body:
				encodeGitPktLine(
					`want ${publishedCommit} multi_ack side-band-64k ofs-delta\n`,
				) +
				encodeGitFlushPkt() +
				encodeGitPktLine('done\n'),
		}),
		envStub(),
		{ fetchImpl: fetchImpl as unknown as typeof fetch },
	)
	expect(uploadPack).not.toBeNull()
	expect(uploadPack!.status).toBe(200)
	expect(uploadPack!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-result',
	)
	expect(uploadPack!.headers.get('Location')).toBeNull()
	expect(uploadPack!.headers.get('WWW-Authenticate')).toBeNull()
	expect(uploadPack!.headers.get('Set-Cookie')).toBeNull()
	expect(await uploadPack!.text()).toBe('PACK-FAKE')
	expect(fetchImpl).toHaveBeenCalledTimes(2)
	const uploadCall = fetchImpl.mock.calls.find(([url]) =>
		String(url).endsWith('/git-upload-pack'),
	)
	expect(uploadCall).toBeDefined()
	expect(new Headers(uploadCall?.[1]?.headers).get('Git-Protocol')).toBe(
		'version=1',
	)

	const unpublishedWant = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-git-upload-pack-request',
			},
			body:
				encodeGitPktLine(`want ${liveCommit}\n`) +
				encodeGitFlushPkt() +
				encodeGitPktLine('done\n'),
		}),
		envStub(),
		{ fetchImpl: fetchImpl as unknown as typeof fetch },
	)
	expect(unpublishedWant!.status).toBe(403)
	expect(await unpublishedWant!.text()).toMatch(/published snapshot/i)
	// Rejected before upstream fetch.
	expect(fetchImpl).toHaveBeenCalledTimes(2)

	const oversized = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-git-upload-pack-request',
				'Content-Length': String(300 * 1024),
			},
			body: new Uint8Array(300 * 1024),
		}),
		envStub(),
		{ fetchImpl: fetchImpl as unknown as typeof fetch },
	)
	expect(oversized!.status).toBe(413)
})

test('public package git HTTP rejects push and hides private packages', async () => {
	resetMocks()

	const receivePack = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-receive-pack', {
			method: 'POST',
			body: 'push',
		}),
		envStub(),
	)
	expect(receivePack!.status).toBe(403)
	expect(await receivePack!.text()).toMatch(/read-only/i)
	expect(resolveCommunityPackageUrl).not.toHaveBeenCalled()

	const receiveInfo = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-receive-pack',
		),
		envStub(),
	)
	expect(receiveInfo!.status).toBe(403)

	resolveCommunityPackageUrl.mockResolvedValue(null)
	const missing = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@someone/private-pkg.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	expect(missing!.status).toBe(404)
	expect(await missing!.text()).toBe('Not Found')
	expect(getCommunityListingById).not.toHaveBeenCalled()
})

test('public package git HTTP redirects listing renames and falls back to a local advertisement', async () => {
	resetMocks()
	resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'redirect',
		listingId: 'listing-1',
		username: 'kody',
		kodyId: 'workers',
	})

	const redirected = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	expect(redirected!.status).toBe(301)
	expect(redirected!.headers.get('Location')).toBe(
		'https://kody.codes/@kody/workers.git/info/refs?service=git-upload-pack',
	)

	resetMocks()
	seedPublicListing()
	const fetchImpl = vi.fn(async () => {
		throw new Error('upstream down')
	})
	const fallback = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
		{ fetchImpl: fetchImpl as unknown as typeof fetch },
	)
	expect(fallback!.status).toBe(200)
	expect(fetchImpl).toHaveBeenCalled()
	const body = await fallback!.text()
	expect(body.startsWith('001e# service=git-upload-pack\n0000')).toBe(true)
	expect(body).toContain(`${publishedCommit} HEAD\0`)
	expect(body).toContain('symref=HEAD:refs/heads/main')
	expect(body).toContain(`${publishedCommit} refs/heads/main\n`)
	expect(body.endsWith('0000')).toBe(true)
})
