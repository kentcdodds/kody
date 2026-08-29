import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'
import { getOauthAppBySlug } from './repo.ts'
import { upsertOauthAppWithoutConnection } from './service.ts'
import { shouldFetchUserOauthAppFavicon } from './user-oauth-app-favicon.ts'
import {
	loadFittedUserOauthAppLogo,
	setUserOauthAppLogo,
} from './user-oauth-app-logo.ts'

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
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: r2.bucket,
		IMAGES: createFakeImagesBinding(),
	} as Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	return { sqlite, db, env, r2 }
}

async function provisionApp(harness: ReturnType<typeof createHarness>) {
	return upsertOauthAppWithoutConnection({
		env: harness.env,
		userId: 'user-1',
		config: {
			name: 'dropbox',
			tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
			apiBaseUrl: 'https://api.dropboxapi.com/2',
			flow: 'pkce',
			clientId: 'dropbox-client',
			authorization: {
				authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
				scopes: [],
			},
		},
	})
}

test('lazy refit of a favicon logo keeps faviconSourceHost', async () => {
	const harness = createHarness()
	const app = await provisionApp(harness)
	const previousKey = `user-oauth-app-logos/${app.userId}/${app.slug}/aaaaaaaaaaaaaaaa.png`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.db
		.prepare(
			`UPDATE user_oauth_apps
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(
			previousKey,
			'image/png',
			'favicon',
			'dropbox.com',
			new Date().toISOString(),
			app.userId,
			app.slug,
		)
		.run()
	const stale = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	expect(stale?.faviconSourceHost).toBe('dropbox.com')

	const served = await loadFittedUserOauthAppLogo({
		db: harness.db,
		env: harness.env,
		userId: app.userId,
		app: stale!,
	})
	expect(served?.contentType).toBe('image/webp')
	const current = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	expect(current?.logoSource).toBe('favicon')
	expect(current?.faviconSourceHost).toBe('dropbox.com')
	expect(current?.logoContentType).toBe('image/webp')
	expect(shouldFetchUserOauthAppFavicon(current!)).toBe(false)
})

test('lazy refit does not overwrite a newer user logo key', async () => {
	const harness = createHarness()
	const app = await provisionApp(harness)
	const previousKey = `user-oauth-app-logos/${app.userId}/${app.slug}/aaaaaaaaaaaaaaaa.png`
	const newerKey = `user-oauth-app-logos/${app.userId}/${app.slug}/bbbbbbbbbbbbbbbb.webp`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.env.COMMUNITY_ASSETS.put(newerKey, tinyWebpBytes, {
		httpMetadata: { contentType: 'image/webp' },
		customMetadata: { iconFitVersion: '2' },
	})
	await harness.db
		.prepare(
			`UPDATE user_oauth_apps
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(
			previousKey,
			'image/png',
			'upload',
			null,
			new Date().toISOString(),
			app.userId,
			app.slug,
		)
		.run()
	const stale = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	await harness.db
		.prepare(
			`UPDATE user_oauth_apps
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(
			newerKey,
			'image/webp',
			'upload',
			null,
			new Date().toISOString(),
			app.userId,
			app.slug,
		)
		.run()

	const served = await loadFittedUserOauthAppLogo({
		db: harness.db,
		env: harness.env,
		userId: app.userId,
		app: stale!,
	})
	expect(served?.contentType).toBe('image/webp')
	const current = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	expect(current?.logoKey).toBe(newerKey)
	expect(harness.r2.objects.has(newerKey)).toBe(true)
})

test('lost same-hash refit race keeps the stored user logo', async () => {
	const harness = createHarness()
	const app = await provisionApp(harness)
	const previousKey = `user-oauth-app-logos/${app.userId}/${app.slug}/aaaaaaaaaaaaaaaa.png`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.db
		.prepare(
			`UPDATE user_oauth_apps
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(
			previousKey,
			'image/png',
			'favicon',
			'dropbox.com',
			new Date().toISOString(),
			app.userId,
			app.slug,
		)
		.run()
	const stale = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	await loadFittedUserOauthAppLogo({
		db: harness.db,
		env: harness.env,
		userId: app.userId,
		app: stale!,
	})
	const winner = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	expect(winner?.logoKey).toMatch(/\.webp$/)

	await setUserOauthAppLogo({
		db: harness.db,
		env: harness.env,
		userId: app.userId,
		slug: app.slug,
		sourceBytes: tinyPngBytes,
		source: 'favicon',
		faviconSourceHost: 'dropbox.com',
		replaceLogoKey: previousKey,
	})
	const current = await getOauthAppBySlug({
		db: harness.db,
		userId: app.userId,
		slug: app.slug,
	})
	expect(current?.logoKey).toBe(winner?.logoKey)
	expect(harness.r2.objects.has(winner!.logoKey!)).toBe(true)
})
