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
	listPlatformProviderMarks,
	normalizeProviderMarkAliases,
	providerMarkMatches,
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

test('upsert, logo write, and delete persist operator provider marks', async () => {
	const { env, objects } = createHarness()
	const created = await upsertPlatformProviderMark({
		db: env.APP_DB,
		slug: 'Google',
		label: 'Google',
		aliases: ['accounts.google.com', 'googleapis.com'],
	})
	expect(created.slug).toBe('google')
	expect(created.aliases).toEqual(['accounts.google.com', 'googleapis.com'])
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
		aliases: ['accounts.google.com'],
	})
	const updated = await getPlatformProviderMarkBySlug({
		db: env.APP_DB,
		slug: 'google',
	})
	expect(updated?.label).toBe('Google')
	expect(updated?.aliases).toEqual(['accounts.google.com'])
	expect(updated?.logoKey).toBe(withLogo.logoKey)

	expect(
		await deletePlatformProviderMark({ db: env.APP_DB, slug: 'google' }),
	).toBe(true)
	expect(
		await getPlatformProviderMarkBySlug({ db: env.APP_DB, slug: 'google' }),
	).toBeNull()
})
