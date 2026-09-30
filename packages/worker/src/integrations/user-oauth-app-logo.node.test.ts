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

type PutOptions = {
	httpMetadata?: { contentType?: string; cacheControl?: string }
	customMetadata?: Record<string, string>
}

function createInMemoryR2() {
	const objects = new Map<
		string,
		PutOptions & { bytes: Uint8Array; httpEtag: string; size: number }
	>()
	const bucket = {
		async put(key: string, bytes: Uint8Array, options: PutOptions = {}) {
			objects.set(key, {
				bytes,
				...options,
				httpEtag: `"etag-${objects.size}"`,
				size: bytes.byteLength,
			})
		},
		async get(key: string) {
			const stored = objects.get(key)
			if (!stored) return null
			return {
				...stored,
				body: new Blob([stored.bytes.slice()]).stream(),
				arrayBuffer: async () => stored.bytes.slice().buffer,
			}
		},
		async delete(key: string) {
			objects.delete(key)
		},
	} as unknown as R2Bucket
	return { bucket, objects }
}

async function createHarness() {
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
	const app = await upsertOauthAppWithoutConnection({
		env,
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
	const { userId, slug } = app
	const keyPrefix = `user-oauth-app-logos/${userId}/${slug}`
	const readApp = () => getOauthAppBySlug({ db, userId, slug })
	const storeLogo = (
		logoKey: string,
		contentType: string,
		source: 'favicon' | 'upload',
	) =>
		db
			.prepare(
				`UPDATE user_oauth_apps
				SET logo_key = ?, logo_content_type = ?, logo_source = ?,
					favicon_source_host = ?, updated_at = ?
				WHERE user_id = ? AND slug = ?`,
			)
			.bind(
				logoKey,
				contentType,
				source,
				source === 'favicon' ? 'dropbox.com' : null,
				new Date().toISOString(),
				userId,
				slug,
			)
			.run()
	const previousKey = `${keyPrefix}/aaaaaaaaaaaaaaaa.png`
	await env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	return { db, env, r2, app, keyPrefix, previousKey, readApp, storeLogo }
}

test('lazy refit of a favicon logo keeps faviconSourceHost, and a lost same-hash refit race keeps the stored logo', async () => {
	const { db, env, r2, app, previousKey, readApp, storeLogo } =
		await createHarness()
	await storeLogo(previousKey, 'image/png', 'favicon')
	const stale = await readApp()
	expect(stale?.faviconSourceHost).toBe('dropbox.com')

	const served = await loadFittedUserOauthAppLogo({
		db,
		env,
		userId: app.userId,
		app: stale!,
	})
	expect(served?.contentType).toBe('image/webp')
	const winner = await readApp()
	expect(winner).toMatchObject({
		logoSource: 'favicon',
		faviconSourceHost: 'dropbox.com',
		logoContentType: 'image/webp',
		logoKey: expect.stringMatching(/\.webp$/),
	})
	expect(shouldFetchUserOauthAppFavicon(winner!)).toBe(false)

	await setUserOauthAppLogo({
		db,
		env,
		userId: app.userId,
		slug: app.slug,
		sourceBytes: tinyPngBytes,
		source: 'favicon',
		faviconSourceHost: 'dropbox.com',
		replaceLogoKey: previousKey,
	})
	expect((await readApp())?.logoKey).toBe(winner?.logoKey)
	expect(r2.objects.has(winner!.logoKey!)).toBe(true)
})

test('lazy refit does not overwrite a newer user logo key', async () => {
	const { db, env, r2, app, keyPrefix, previousKey, readApp, storeLogo } =
		await createHarness()
	const newerKey = `${keyPrefix}/bbbbbbbbbbbbbbbb.webp`
	await env.COMMUNITY_ASSETS.put(newerKey, tinyWebpBytes, {
		httpMetadata: { contentType: 'image/webp' },
		customMetadata: { iconFitVersion: '2' },
	})
	await storeLogo(previousKey, 'image/png', 'upload')
	const stale = await readApp()
	await storeLogo(newerKey, 'image/webp', 'upload')

	const served = await loadFittedUserOauthAppLogo({
		db,
		env,
		userId: app.userId,
		app: stale!,
	})
	expect(served?.contentType).toBe('image/webp')
	expect((await readApp())?.logoKey).toBe(newerKey)
	expect(r2.objects.has(newerKey)).toBe(true)
})
