import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
} from '#worker/test-support/images-binding.ts'
import {
	buildProviderMarkLogoPath,
	deletePlatformProviderMark,
	getPlatformProviderMarkBySlug,
	hostMatchesProviderMarkToken,
	listPlatformProviderMarks,
	normalizeProviderMarkAliases,
	providerMarkAliasTokens,
	providerMarkMatches,
	attachCatalogLogoPath,
	resolveProviderMark,
	resolveProviderMarkLogoPath,
	setPlatformProviderMarkLogo,
	upsertPlatformProviderMark,
} from './provider-marks.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const objects = new Map<string, Uint8Array>()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		COMMUNITY_ASSETS: {
			async put(key: string, bytes: Uint8Array) {
				objects.set(key, bytes)
			},
			async get(key: string) {
				const stored = objects.get(key)
				if (!stored) return null
				return {
					body: new Blob([stored.slice()]).stream(),
					size: stored.byteLength,
					httpEtag: `"etag-${key}"`,
					arrayBuffer: async () => stored.slice().buffer,
				}
			},
			async delete(key: string) {
				objects.delete(key)
			},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
	}
	return { env, objects }
}

function makeMark(
	slug: string,
	{
		aliases = [] as Array<string>,
		logoKey = `platform-provider-marks/${slug}/abc.webp` as string | null,
	} = {},
) {
	return {
		slug,
		label: slug,
		aliases,
		logoKey,
		logoContentType: logoKey ? 'image/webp' : null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

test('provider mark matching prefers exact slug then family then host aliases', () => {
	const google = {
		slug: 'google',
		aliases: ['accounts.google.com', 'googleapis.com', 'oauth2.googleapis.com'],
	}
	const x = { slug: 'x', aliases: ['twitter', 'x.com', 'twitter.com'] }
	const github = { slug: 'github', aliases: [] }
	const matchCases = [
		{ mark: google, providerKey: 'google', expected: true },
		{ mark: google, providerKey: 'google-youtube-brand', expected: true },
		{ mark: google, host: 'accounts.google.com', expected: true },
		{ mark: google, providerKey: 'dropbox', expected: false },
		{ mark: x, providerKey: 'example', expected: false },
		{ mark: x, providerKey: 'x-kodykoala', expected: true },
		{ mark: x, providerKey: 'twitter', expected: true },
		{ mark: github, host: 'api.github.com', expected: true },
		{ mark: github, providerKey: 'github-platform', expected: true },
	]
	expect(
		matchCases.filter(
			({ expected, ...input }) => providerMarkMatches(input) !== expected,
		),
	).toEqual([])
	const hostTokenCases = [
		{ host: 'accounts.google.com', token: 'google', expected: true },
		{ host: 'github.com', token: 'git', expected: false },
		{ host: 'example.com', token: 'x', expected: false },
		{ host: 'login.example.app', token: 'app', expected: false },
		{ host: 'example.ai', token: 'ai', expected: false },
	]
	expect(
		hostTokenCases.filter(
			({ host, token, expected }) =>
				hostMatchesProviderMarkToken(host, token) !== expected,
		),
	).toEqual([])
	expect(providerMarkAliasTokens({ slug: 'youtube', aliases: [] })).toEqual(
		expect.arrayContaining([
			'google-youtube-brand',
			'google-youtube-plus',
			'www.youtube.com',
		]),
	)

	const marks = [
		makeMark('google', { aliases: google.aliases }),
		makeMark('x', { aliases: x.aliases, logoKey: null }),
	]
	const resolveCases = [
		{ marks, providerKey: 'google-youtube-brand', expected: 'google' },
		{
			marks: [...marks, makeMark('youtube')],
			providerKey: 'google-youtube-brand',
			host: 'www.youtube.com',
			expected: 'youtube',
		},
		{
			marks: [makeMark('nodedotjs')],
			providerKey: 'nodejs',
			host: 'nodejs.org',
			expected: 'nodedotjs',
		},
		{
			marks: ['google', 'google-calendar', 'gmail'].map((s) => makeMark(s)),
			host: 'calendar.google.com',
			expected: 'google-calendar',
		},
		{
			marks: ['google', 'gmail'].map((s) => makeMark(s)),
			host: 'mail.google.com',
			expected: 'gmail',
		},
	]
	expect(
		resolveCases.filter(
			({ expected, ...input }) => resolveProviderMark(input)?.slug !== expected,
		),
	).toEqual([])
	expect(resolveProviderMarkLogoPath({ marks, providerKey: 'x' })).toBeNull()
	expect(normalizeProviderMarkAliases([' Gmail ', 'gmail', ''])).toEqual([
		'gmail',
	])
	expect(
		buildProviderMarkLogoPath({
			slug: 'google',
			logoKey: 'platform-provider-marks/google/abcdef0123456789.webp',
		}),
	).toBe('/integrations/provider-marks/google?v=abcdef0123456789')
})

test('catalog attachment resolves MCP servers by name and host', () => {
	const linear = makeMark('linear', {
		logoKey: 'platform-provider-marks/linear/abcdef0123456789.webp',
	})
	const logoPathFor = (name: string, url: string) =>
		attachCatalogLogoPath({ name, url }, [linear]).catalogLogoPath
	const linearPath = '/integrations/provider-marks/linear?v=abcdef0123456789'
	expect(logoPathFor('linear', 'https://mcp.linear.app/mcp')).toBe(linearPath)
	expect(logoPathFor('work', 'https://mcp.linear.app/mcp')).toBe(linearPath)
	expect(logoPathFor('notes', 'https://mcp.example.com/mcp')).toBeNull()
})

test('upsert, logo write, and delete persist operator provider marks', async () => {
	const { env, objects } = createHarness()
	const db = env.APP_DB
	const setLogo = (sourceBytes: Uint8Array | null) =>
		setPlatformProviderMarkLogo({ db, env, slug: 'google', sourceBytes })
	const created = await upsertPlatformProviderMark({
		db,
		slug: 'Google',
		label: 'Google',
		aliases: ['accounts.google.com', 'googleapis.com', 'my-google-work'],
	})
	expect(created.slug).toBe('google')
	expect(created.aliases).toEqual(['my-google-work'])
	expect(created.logoKey).toBeNull()

	const withLogo = await setLogo(tinyPngBytes)
	expect(withLogo.logoKey).toMatch(/^platform-provider-marks\/google\//)
	expect(objects.has(withLogo.logoKey!)).toBe(true)
	expect((await setLogo(null)).logoKey).toBeNull()
	expect(objects.has(withLogo.logoKey!)).toBe(false)
	const restored = await setLogo(tinyPngBytes)
	expect(restored.logoKey).toMatch(/^platform-provider-marks\/google\//)
	expect(objects.has(restored.logoKey!)).toBe(true)
	expect(
		resolveProviderMarkLogoPath({
			marks: await listPlatformProviderMarks({ db }),
			providerKey: 'google-work',
			host: 'accounts.google.com',
		}),
	).toContain('/integrations/provider-marks/google')

	await upsertPlatformProviderMark({
		db,
		slug: 'google',
		aliases: ['accounts.google.com', 'workspace-google'],
	})
	const updated = await getPlatformProviderMarkBySlug({ db, slug: 'google' })
	expect(updated?.label).toBe('Google')
	expect(updated?.aliases).toEqual(['workspace-google'])
	expect(updated?.logoKey).toBe(withLogo.logoKey)

	expect(await deletePlatformProviderMark({ db, slug: 'google' })).toBe(true)
	expect(await getPlatformProviderMarkBySlug({ db, slug: 'google' })).toBeNull()
})
