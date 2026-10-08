import {
	ProtocolError,
	ResourceNotFoundError,
} from '@modelcontextprotocol/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	buildPackageSkillsIndex,
	collectPackageSkills,
	type PackageSkillsIndex,
} from '#worker/package-registry/package-skills.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

const mocks = vi.hoisted(() => ({
	listOwn: vi.fn(),
	listShared: vi.fn(),
	listPlatform: vi.fn(),
	listEntitySourcesByIds: vi.fn(),
	readIndex: vi.fn(),
	writeIndex: vi.fn(),
	loadSource: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesWithCommunityProvenanceByUserId: (...args: Array<unknown>) =>
		mocks.listOwn(...args),
}))
vi.mock('#worker/package-registry/share-grants.ts', () => ({
	listAcceptedInboundSharedPackages: (...args: Array<unknown>) =>
		mocks.listShared(...args),
}))
vi.mock('#worker/package-registry/platform-packages.ts', () => ({
	listPlatformPackagesForSearch: (...args: Array<unknown>) =>
		mocks.listPlatform(...args),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesByIds: (...args: Array<unknown>) =>
		mocks.listEntitySourcesByIds(...args),
}))
vi.mock('#worker/package-registry/skills-index-cache.ts', () => ({
	readPackageSkillsIndex: (...args: Array<unknown>) => mocks.readIndex(...args),
	writePackageSkillsIndex: (...args: Array<unknown>) =>
		mocks.writeIndex(...args),
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mocks.loadSource(...args),
}))

const {
	buildSkillResourcesListResult,
	buildSkillsGetResult,
	buildSkillsListResult,
	loadCallerSkillsCatalog,
	readCatalogSkillResource,
} = await import('./skills-catalog.ts')

const env = { APP_DB: {} } as unknown as Env
const callerContext = createMcpCallerContext({
	baseUrl: 'https://kody.example',
	user: { userId: 'user-1', email: 'a@example.com', displayName: 'A' },
})

const skillMd = [
	'---',
	'name: ship-it',
	'description: Ship the thing.',
	'---',
	'',
	'# Ship it',
].join('\n')
const referenceMd = '# Reference\n'

const packageFiles = {
	'skills/ship-it/SKILL.md': skillMd,
	'skills/ship-it/references/guide.md': referenceMd,
}

function savedPackage(
	overrides: Partial<SavedPackageRecord> = {},
): SavedPackageRecord {
	return {
		id: 'pkg-1',
		userId: 'user-1',
		name: '@owner/ship',
		kodyId: 'ship',
		description: '',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hasSkills: true,
		hidden: false,
		isPrivate: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

async function buildIndex(
	record: SavedPackageRecord,
	publishedCommit = 'commit-1',
	files: Record<string, string> = packageFiles,
): Promise<PackageSkillsIndex> {
	return buildPackageSkillsIndex({
		packageId: record.id,
		kodyId: record.name,
		publishedCommit,
		skills: await collectPackageSkills({ files, kodyId: record.name }),
	})
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset()
	mocks.listOwn.mockResolvedValue([])
	mocks.listShared.mockResolvedValue([])
	mocks.listPlatform.mockResolvedValue([])
	mocks.listEntitySourcesByIds.mockImplementation(
		async (_db: unknown, ids: Array<string>) =>
			ids.map((id) => ({ id, published_commit: 'commit-1' })),
	)
	mocks.readIndex.mockResolvedValue(null)
	mocks.loadSource.mockResolvedValue({
		files: packageFiles,
		manifest: { name: '@owner/ship', kody: { id: 'ship' } },
	})
})

test('anonymous callers get an empty catalog without touching storage', async () => {
	const catalog = await loadCallerSkillsCatalog({
		env,
		callerContext: createMcpCallerContext({ baseUrl: 'https://kody.example' }),
	})
	expect(catalog).toEqual([])
	expect(mocks.listOwn).not.toHaveBeenCalled()
})

test('lists own, shared, and platform skills from KV indexes, skipping hidden and skill-less packages', async () => {
	const own = savedPackage()
	const hidden = savedPackage({ id: 'pkg-hidden', sourceId: 'source-hidden' })
	hidden.hidden = true
	const noSkills = savedPackage({
		id: 'pkg-none',
		sourceId: 'source-none',
		hasSkills: false,
	})
	const shared = savedPackage({
		id: 'pkg-shared',
		userId: 'user-2',
		name: '@friend/shared',
		kodyId: 'shared',
		sourceId: 'source-shared',
	})
	const platform = savedPackage({
		id: 'pkg-platform',
		userId: 'platform-user',
		name: '@kody/platform',
		kodyId: 'platform',
		sourceId: 'source-platform',
	})
	mocks.listOwn.mockResolvedValue([own, hidden, noSkills])
	mocks.listShared.mockResolvedValue([shared])
	mocks.listPlatform.mockResolvedValue([
		{ record: platform, platformScope: 'kody' },
	])
	const indexes = new Map<string, PackageSkillsIndex>()
	for (const record of [own, shared, platform]) {
		indexes.set(record.id, await buildIndex(record))
	}
	mocks.readIndex.mockImplementation(
		async (input: { packageId: string }) =>
			indexes.get(input.packageId) ?? null,
	)

	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	expect(catalog.map((entry) => entry.packageId)).toEqual([
		'pkg-1',
		'pkg-shared',
		'pkg-platform',
	])
	expect(mocks.listEntitySourcesByIds).toHaveBeenCalledWith(env.APP_DB, [
		'source-1',
		'source-shared',
		'source-platform',
	])
	expect(mocks.readIndex).toHaveBeenCalledWith({
		env,
		userId: 'user-2',
		packageId: 'pkg-shared',
		publishedCommit: 'commit-1',
	})
	expect(mocks.loadSource).not.toHaveBeenCalled()

	const listed = buildSkillsListResult(catalog)
	expect(listed).toMatchObject({
		resultType: 'complete',
		ttlMs: 300_000,
		cacheScope: 'private',
	})
	expect(listed.skills.map((skill) => skill.uri)).toEqual([
		'skill://owner/ship/ship-it/SKILL.md',
		'skill://friend/shared/ship-it/SKILL.md',
		'skill://kody/platform/ship-it/SKILL.md',
	])
	expect(listed.skills[0]).toEqual({
		uri: 'skill://owner/ship/ship-it/SKILL.md',
		frontmatter: { name: 'ship-it', description: 'Ship the thing.' },
		resources: [
			{
				uri: 'skill://owner/ship/ship-it/SKILL.md',
				digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				size: new TextEncoder().encode(skillMd).byteLength,
			},
			{
				uri: 'skill://owner/ship/ship-it/references/guide.md',
				digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				size: referenceMd.length,
			},
		],
	})
})

test('platform package shadowed by the caller own package is not listed twice', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.listPlatform.mockResolvedValue([
		{
			record: savedPackage({
				id: 'pkg-platform',
				userId: 'platform-user',
				sourceId: 'source-platform',
			}),
			platformScope: 'kody',
		},
	])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })
	expect(catalog.map((entry) => entry.packageId)).toEqual(['pkg-1'])
})

test('rebuilds and persists a missing index for packages published before the flag', async () => {
	mocks.listOwn.mockResolvedValue([savedPackage()])

	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	expect(mocks.loadSource).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://kody.example',
		userId: 'user-1',
		sourceId: 'source-1',
	})
	expect(mocks.writeIndex).toHaveBeenCalledTimes(1)
	expect(mocks.writeIndex.mock.calls[0]![0]).toMatchObject({
		userId: 'user-1',
		index: { packageId: 'pkg-1', publishedCommit: 'commit-1' },
	})
	expect(buildSkillsListResult(catalog).skills).toHaveLength(1)
})

test('fails loudly with an internal error when a lazy rebuild fails', async () => {
	mocks.listOwn.mockResolvedValue([savedPackage()])
	mocks.loadSource.mockRejectedValue(new Error('snapshot gone'))

	const failure = await loadCallerSkillsCatalog({ env, callerContext }).catch(
		(error: unknown) => error,
	)

	expect(failure).toBeInstanceOf(ProtocolError)
	expect(failure).toMatchObject({
		code: -32603,
		message: expect.stringContaining('snapshot gone'),
	})
})

test('skills/get returns one skill and rejects unknown URIs with -32602', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	const found = buildSkillsGetResult(
		catalog,
		'skill://owner/ship/ship-it/SKILL.md',
	)
	expect(found).toMatchObject({
		resultType: 'complete',
		skill: { uri: 'skill://owner/ship/ship-it/SKILL.md' },
		ttlMs: 300_000,
		cacheScope: 'private',
	})

	const failure = (() => {
		try {
			buildSkillsGetResult(catalog, 'skill://owner/ship/other/SKILL.md')
		} catch (error) {
			return error
		}
		return null
	})()
	expect(failure).toBeInstanceOf(ProtocolError)
	expect(failure).toMatchObject({ code: -32602 })
})

test('resources/list exposes every skill file, with the description on SKILL.md', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	expect(buildSkillResourcesListResult(catalog).resources).toEqual([
		{
			uri: 'skill://owner/ship/ship-it/SKILL.md',
			name: 'ship-it',
			mimeType: 'text/markdown',
			size: new TextEncoder().encode(skillMd).byteLength,
			description: 'Ship the thing.',
		},
		{
			uri: 'skill://owner/ship/ship-it/references/guide.md',
			name: 'ship-it/references/guide.md',
			mimeType: 'text/markdown',
			size: referenceMd.length,
		},
	])
})

test('resources/read returns verified text content and rejects unknown URIs', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	const result = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/references/guide.md',
	})
	expect(result).toEqual({
		contents: [
			{
				uri: 'skill://owner/ship/ship-it/references/guide.md',
				mimeType: 'text/markdown',
				text: referenceMd,
			},
		],
	})

	const missing = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/nope.md',
	}).catch((error: unknown) => error)
	expect(missing).toBeInstanceOf(ResourceNotFoundError)
	expect(missing).toMatchObject({ code: -32602 })
})

test('resources/read fails when the snapshot no longer matches the indexed digest', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })
	mocks.loadSource.mockResolvedValue({
		files: {
			...packageFiles,
			'skills/ship-it/references/guide.md': '# Tampered\n',
		},
		manifest: { kody: { id: '@owner/ship' } },
	})

	const failure = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/references/guide.md',
	}).catch((error: unknown) => error)

	expect(failure).toMatchObject({
		code: -32603,
		message: expect.stringContaining('digest'),
	})
})
