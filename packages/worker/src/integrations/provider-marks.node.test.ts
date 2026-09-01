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
					body: new Blob([stored]).stream(),
					size: stored.byteLength,
					httpEtag: `"etag-${key}"`,
					async arrayBuffer() {
						const copy = new Uint8Array(stored.byteLength)
						copy.set(stored)
						return copy.buffer
					},
				}
			},
			async delete(key: string) {
				objects.delete(key)
			},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	return { env, objects }
}

test('provider mark matching prefers exact slug then family then host aliases', () => {
	const google = {
		slug: 'google',
		aliases: ['accounts.google.com', 'googleapis.com', 'oauth2.googleapis.com'],
	}
	const x = {
		slug: 'x',
		aliases: ['twitter', 'x.com', 'twitter.com'],
	}
	expect(
		providerMarkMatches({
			mark: google,
			providerKey: 'google',
		}),
	).toBe(true)
	expect(
		providerMarkMatches({
			mark: google,
			providerKey: 'google-youtube-brand',
		}),
	).toBe(true)
	expect(
		providerMarkMatches({
			mark: google,
			host: 'accounts.google.com',
		}),
	).toBe(true)
	expect(
		providerMarkMatches({
			mark: google,
			providerKey: 'dropbox',
		}),
	).toBe(false)
	expect(providerMarkMatches({ mark: x, providerKey: 'example' })).toBe(false)
	expect(providerMarkMatches({ mark: x, providerKey: 'x-kodykoala' })).toBe(
		true,
	)
	expect(providerMarkMatches({ mark: x, providerKey: 'twitter' })).toBe(true)
	expect(
		providerMarkMatches({
			mark: { slug: 'github', aliases: [] },
			host: 'api.github.com',
		}),
	).toBe(true)
	expect(
		providerMarkMatches({
			mark: { slug: 'github', aliases: [] },
			providerKey: 'github-platform',
		}),
	).toBe(true)
	expect(hostMatchesProviderMarkToken('accounts.google.com', 'google')).toBe(
		true,
	)
	expect(hostMatchesProviderMarkToken('github.com', 'git')).toBe(false)
	expect(hostMatchesProviderMarkToken('example.com', 'x')).toBe(false)
	expect(hostMatchesProviderMarkToken('login.example.app', 'app')).toBe(false)
	expect(hostMatchesProviderMarkToken('example.ai', 'ai')).toBe(false)
	expect(providerMarkAliasTokens({ slug: 'youtube', aliases: [] })).toEqual(
		expect.arrayContaining([
			'google-youtube-brand',
			'google-youtube-plus',
			'www.youtube.com',
		]),
	)

	const marks = [
		{
			slug: 'google',
			label: 'Google',
			aliases: google.aliases,
			logoKey: 'platform-provider-marks/google/abc.webp',
			logoContentType: 'image/webp',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		{
			slug: 'x',
			label: 'X',
			aliases: x.aliases,
			logoKey: null,
			logoContentType: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	]
	expect(
		resolveProviderMark({
			marks,
			providerKey: 'google-youtube-brand',
		})?.slug,
	).toBe('google')
	expect(
		resolveProviderMark({
			marks: [
				...marks,
				{
					slug: 'youtube',
					label: 'YouTube',
					aliases: [],
					logoKey: 'platform-provider-marks/youtube/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			providerKey: 'google-youtube-brand',
			host: 'www.youtube.com',
		})?.slug,
	).toBe('youtube')
	expect(
		resolveProviderMark({
			marks: [
				{
					slug: 'nodedotjs',
					label: 'Node.js',
					aliases: [],
					logoKey: 'platform-provider-marks/nodedotjs/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			providerKey: 'nodejs',
			host: 'nodejs.org',
		})?.slug,
	).toBe('nodedotjs')
	expect(
		resolveProviderMark({
			marks: [
				{
					slug: 'google',
					label: 'Google',
					aliases: [],
					logoKey: 'platform-provider-marks/google/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					slug: 'google-calendar',
					label: 'Google Calendar',
					aliases: [],
					logoKey: 'platform-provider-marks/google-calendar/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					slug: 'gmail',
					label: 'Gmail',
					aliases: [],
					logoKey: 'platform-provider-marks/gmail/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			host: 'calendar.google.com',
		})?.slug,
	).toBe('google-calendar')
	expect(
		resolveProviderMark({
			marks: [
				{
					slug: 'google',
					label: 'Google',
					aliases: [],
					logoKey: 'platform-provider-marks/google/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					slug: 'gmail',
					label: 'Gmail',
					aliases: [],
					logoKey: 'platform-provider-marks/gmail/abc.webp',
					logoContentType: 'image/webp',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			host: 'mail.google.com',
		})?.slug,
	).toBe('gmail')
	expect(
		resolveProviderMarkLogoPath({
			marks,
			providerKey: 'x',
		}),
	).toBeNull()
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
	const linear = {
		slug: 'linear',
		label: 'Linear',
		aliases: [],
		logoKey: 'platform-provider-marks/linear/abcdef0123456789.webp',
		logoContentType: 'image/webp',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	expect(
		attachCatalogLogoPath(
			{ name: 'linear', url: 'https://mcp.linear.app/mcp' },
			[linear],
		).catalogLogoPath,
	).toBe('/integrations/provider-marks/linear?v=abcdef0123456789')
	expect(
		attachCatalogLogoPath({ name: 'work', url: 'https://mcp.linear.app/mcp' }, [
			linear,
		]).catalogLogoPath,
	).toBe('/integrations/provider-marks/linear?v=abcdef0123456789')
	expect(
		attachCatalogLogoPath(
			{ name: 'notes', url: 'https://mcp.example.com/mcp' },
			[linear],
		).catalogLogoPath,
	).toBeNull()
})

test('upsert, logo write, and delete persist operator provider marks', async () => {
	const { env, objects } = createHarness()
	const created = await upsertPlatformProviderMark({
		db: env.APP_DB,
		slug: 'Google',
		label: 'Google',
		aliases: ['accounts.google.com', 'googleapis.com', 'my-google-work'],
	})
	expect(created.slug).toBe('google')
	expect(created.aliases).toEqual(['my-google-work'])
	expect(created.logoKey).toBeNull()

	const withLogo = await setPlatformProviderMarkLogo({
		db: env.APP_DB,
		env,
		slug: 'google',
		sourceBytes: tinyPngBytes,
	})
	expect(withLogo.logoKey).toMatch(/^platform-provider-marks\/google\//)
	expect(objects.has(withLogo.logoKey!)).toBe(true)
	const cleared = await setPlatformProviderMarkLogo({
		db: env.APP_DB,
		env,
		slug: 'google',
		sourceBytes: null,
	})
	expect(cleared.logoKey).toBeNull()
	expect(objects.has(withLogo.logoKey!)).toBe(false)
	const restored = await setPlatformProviderMarkLogo({
		db: env.APP_DB,
		env,
		slug: 'google',
		sourceBytes: tinyPngBytes,
	})
	expect(restored.logoKey).toMatch(/^platform-provider-marks\/google\//)
	expect(objects.has(restored.logoKey!)).toBe(true)
	expect(
		resolveProviderMarkLogoPath({
			marks: await listPlatformProviderMarks({ db: env.APP_DB }),
			providerKey: 'google-work',
			host: 'accounts.google.com',
		}),
	).toContain('/integrations/provider-marks/google')

	await upsertPlatformProviderMark({
		db: env.APP_DB,
		slug: 'google',
		aliases: ['accounts.google.com', 'workspace-google'],
	})
	const updated = await getPlatformProviderMarkBySlug({
		db: env.APP_DB,
		slug: 'google',
	})
	expect(updated?.label).toBe('Google')
	expect(updated?.aliases).toEqual(['workspace-google'])
	expect(updated?.logoKey).toBe(withLogo.logoKey)

	expect(
		await deletePlatformProviderMark({ db: env.APP_DB, slug: 'google' }),
	).toBe(true)
	expect(
		await getPlatformProviderMarkBySlug({ db: env.APP_DB, slug: 'google' }),
	).toBeNull()
})
