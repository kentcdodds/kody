import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'
import {
	buildPlatformOauthAppLogoPath,
	getPlatformOauthAppLogoObject,
	loadFittedPlatformOauthAppLogo,
	setPlatformOauthAppLogo,
} from './platform-app-logo.ts'
import {
	getPlatformOauthAppBySlug,
	upsertPlatformOauthApp,
} from './platform-apps.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

type StoredObject = {
	bytes: Uint8Array
	httpMetadata?: { contentType?: string; cacheControl?: string }
	customMetadata?: Record<string, string>
	httpEtag: string
	size: number
}

function createInMemoryR2() {
	const objects = new Map<string, StoredObject>()
	const bucket = {
		async put(
			key: string,
			bytes: Uint8Array,
			options?: {
				httpMetadata?: { contentType?: string; cacheControl?: string }
				customMetadata?: Record<string, string>
			},
		) {
			objects.set(key, {
				bytes,
				...(options?.httpMetadata
					? { httpMetadata: options.httpMetadata }
					: {}),
				...(options?.customMetadata
					? { customMetadata: options.customMetadata }
					: {}),
				httpEtag: `"etag-${objects.size}"`,
				size: bytes.byteLength,
			})
		},
		async get(key: string) {
			const stored = objects.get(key)
			if (!stored) return null
			return {
				...stored,
				body: new Blob([stored.bytes]).stream(),
				async arrayBuffer() {
					const copy = new Uint8Array(stored.bytes.byteLength)
					copy.set(stored.bytes)
					return copy.buffer
				},
			}
		},
		async delete(key: string) {
			objects.delete(key)
		},
	} as unknown as R2Bucket
	return { bucket, objects }
}

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const r2 = createInMemoryR2()
	const env = {
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: r2.bucket,
		IMAGES: createFakeImagesBinding(),
	} as Pick<Env, 'SECRET_STORE_KEY' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	return { sqlite, db, env, r2 }
}

async function provisionApp(harness: ReturnType<typeof createHarness>) {
	return upsertPlatformOauthApp({
		db: harness.db,
		env: harness.env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
		},
	})
}

test('logo lifecycle uploads, clears, and survives app upserts without touching logo columns', async () => {
	const harness = createHarness()
	await provisionApp(harness)

	const withLogo = await setPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		slug: 'github',
		sourceBytes: tinyPngBytes,
	})
	expect(withLogo.logoKey).toMatch(
		/^platform-oauth-app-logos\/github\/[0-9a-f]{16}\.webp$/,
	)
	expect(withLogo.logoContentType).toBe('image/webp')
	expect(harness.r2.objects.size).toBe(1)
	const stored = harness.r2.objects.get(withLogo.logoKey!)
	expect(stored?.bytes).toEqual(tinyWebpBytes)
	expect(stored?.customMetadata?.iconFitVersion).toBe('2')
	expect(buildPlatformOauthAppLogoPath(withLogo)).toMatch(
		/^\/integrations\/logos\/github\?v=[0-9a-f]{16}$/,
	)
	expect(
		await getPlatformOauthAppLogoObject({
			env: harness.env,
			logoKey: withLogo.logoKey!,
		}),
	).not.toBeNull()

	const cleared = await setPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		slug: 'github',
		sourceBytes: null,
	})
	expect(cleared.logoKey).toBeNull()
	expect(cleared.logoContentType).toBeNull()
	expect(harness.r2.objects.size).toBe(0)
	expect(buildPlatformOauthAppLogoPath(cleared)).toBeNull()

	await setPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		slug: 'github',
		sourceBytes: tinyPngBytes,
	})
	const updated = await upsertPlatformOauthApp({
		db: harness.db,
		env: harness.env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			enabled: false,
		},
	})
	expect(updated.logoKey).toMatch(/^platform-oauth-app-logos\/github\//)
	expect(
		buildPlatformOauthAppLogoPath({
			slug: 'openai.com',
			logoKey: 'platform-oauth-app-logos/openai.com/0123456789abcdef.webp',
		}),
	).toBe('/integrations/logos/openai%2Ecom?v=0123456789abcdef')
})

test('uploads reject unknown formats and unknown apps', async () => {
	const harness = createHarness()
	await provisionApp(harness)

	await expect(
		setPlatformOauthAppLogo({
			db: harness.db,
			env: harness.env,
			slug: 'github',
			sourceBytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
		}),
	).rejects.toThrow('must be SVG, PNG, JPEG, or WebP')

	await expect(
		setPlatformOauthAppLogo({
			db: harness.db,
			env: harness.env,
			slug: 'missing',
			sourceBytes: tinyPngBytes,
		}),
	).rejects.toThrow('was not found')
})

test('serving an unfitted logo rewrites it to the current WebP ingest', async () => {
	const harness = createHarness()
	const app = await provisionApp(harness)
	const previousKey = `platform-oauth-app-logos/${app.slug}/aaaaaaaaaaaaaaaa.png`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.db
		.prepare(
			`UPDATE platform_oauth_apps
			SET logo_key = ?, logo_content_type = ?, updated_at = ?
			WHERE slug = ?`,
		)
		.bind(previousKey, 'image/png', new Date().toISOString(), app.slug)
		.run()
	const stale = await getPlatformOauthAppBySlug({
		db: harness.db,
		slug: 'github',
		includeDisabled: true,
	})
	expect(stale?.logoKey).toBe(previousKey)

	const served = await loadFittedPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		app: stale!,
	})
	expect(served?.contentType).toBe('image/webp')
	expect(served?.cacheControl).toBe('public, max-age=31536000, immutable')
	expect(harness.r2.objects.has(previousKey)).toBe(false)
	expect(harness.r2.objects.size).toBe(1)
	const [fittedKey, fitted] = [...harness.r2.objects.entries()][0]!
	expect(fittedKey).toMatch(
		/^platform-oauth-app-logos\/github\/[0-9a-f]{16}\.webp$/,
	)
	expect(fitted.bytes).toEqual(tinyWebpBytes)
	expect(fitted.customMetadata?.iconFitVersion).toBe('2')
})

test('lazy refit does not overwrite a newer logo key', async () => {
	const harness = createHarness()
	const app = await provisionApp(harness)
	const previousKey = `platform-oauth-app-logos/${app.slug}/aaaaaaaaaaaaaaaa.png`
	const newerKey = `platform-oauth-app-logos/${app.slug}/bbbbbbbbbbbbbbbb.webp`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.env.COMMUNITY_ASSETS.put(newerKey, tinyWebpBytes, {
		httpMetadata: { contentType: 'image/webp' },
		customMetadata: { iconFitVersion: '2' },
	})
	await harness.db
		.prepare(
			`UPDATE platform_oauth_apps
			SET logo_key = ?, logo_content_type = ?, updated_at = ?
			WHERE slug = ?`,
		)
		.bind(previousKey, 'image/png', new Date().toISOString(), app.slug)
		.run()
	const stale = await getPlatformOauthAppBySlug({
		db: harness.db,
		slug: 'github',
		includeDisabled: true,
	})
	await harness.db
		.prepare(
			`UPDATE platform_oauth_apps
			SET logo_key = ?, logo_content_type = ?, updated_at = ?
			WHERE slug = ?`,
		)
		.bind(newerKey, 'image/webp', new Date().toISOString(), app.slug)
		.run()

	const served = await loadFittedPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		app: stale!,
	})
	expect(served?.contentType).toBe('image/webp')
	const current = await getPlatformOauthAppBySlug({
		db: harness.db,
		slug: 'github',
		includeDisabled: true,
	})
	expect(current?.logoKey).toBe(newerKey)
	expect(harness.r2.objects.has(newerKey)).toBe(true)
})

test('lost same-hash refit race keeps the stored object', async () => {
	const harness = createHarness()
	const app = await provisionApp(harness)
	const previousKey = `platform-oauth-app-logos/${app.slug}/aaaaaaaaaaaaaaaa.png`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.db
		.prepare(
			`UPDATE platform_oauth_apps
			SET logo_key = ?, logo_content_type = ?, updated_at = ?
			WHERE slug = ?`,
		)
		.bind(previousKey, 'image/png', new Date().toISOString(), app.slug)
		.run()
	const stale = await getPlatformOauthAppBySlug({
		db: harness.db,
		slug: 'github',
		includeDisabled: true,
	})
	await loadFittedPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		app: stale!,
	})
	const winner = await getPlatformOauthAppBySlug({
		db: harness.db,
		slug: 'github',
		includeDisabled: true,
	})
	expect(winner?.logoKey).toMatch(
		/^platform-oauth-app-logos\/github\/[0-9a-f]{16}\.webp$/,
	)

	await setPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		slug: 'github',
		sourceBytes: tinyPngBytes,
		replaceLogoKey: previousKey,
	})
	const current = await getPlatformOauthAppBySlug({
		db: harness.db,
		slug: 'github',
		includeDisabled: true,
	})
	expect(current?.logoKey).toBe(winner?.logoKey)
	expect(harness.r2.objects.has(winner!.logoKey!)).toBe(true)
})
