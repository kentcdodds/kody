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
	iconFitCustomMetadata,
	logoNeedsIconFit,
} from '#worker/community/icon-fit.ts'
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
const fittedKeyPattern =
	/^platform-oauth-app-logos\/github\/[0-9a-f]{16}\.webp$/
const previousKey = 'platform-oauth-app-logos/github/aaaaaaaaaaaaaaaa.png'

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

const githubApp = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	flow: 'confidential' as const,
}

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const r2 = createInMemoryR2()
	const env = {
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: r2.bucket,
		IMAGES: createFakeImagesBinding(),
	} as Pick<Env, 'SECRET_STORE_KEY' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	await upsertPlatformOauthApp({
		db,
		env,
		app: { ...githubApp, clientSecret: 'platform-github-client-secret-value' },
	})
	const setLogo = (sourceBytes: Uint8Array | null, slug = 'github') =>
		setPlatformOauthAppLogo({ db, env, slug, sourceBytes })
	const readApp = () =>
		getPlatformOauthAppBySlug({ db, slug: 'github', includeDisabled: true })
	const storeLogo = (logoKey: string, contentType: string) =>
		db
			.prepare(
				`UPDATE platform_oauth_apps
				SET logo_key = ?, logo_content_type = ?, updated_at = ?
				WHERE slug = ?`,
			)
			.bind(logoKey, contentType, new Date().toISOString(), 'github')
			.run()
	const loadFitted = (app: Awaited<ReturnType<typeof readApp>>) =>
		loadFittedPlatformOauthAppLogo({ db, env, app: app! })
	return { db, env, r2, setLogo, readApp, storeLogo, loadFitted }
}

test('logo lifecycle uploads, clears, rejects bad input, and survives app upserts without touching logo columns', async () => {
	const { db, env, r2, setLogo } = await createHarness()
	const withLogo = await setLogo(tinyPngBytes)
	expect(withLogo.logoKey).toMatch(fittedKeyPattern)
	expect(withLogo.logoContentType).toBe('image/webp')
	expect(r2.objects.size).toBe(1)
	const stored = r2.objects.get(withLogo.logoKey!)
	expect(stored?.bytes).toEqual(tinyWebpBytes)
	expect(logoNeedsIconFit(stored?.customMetadata)).toBe(false)
	expect(buildPlatformOauthAppLogoPath(withLogo)).toMatch(
		/^\/integrations\/logos\/github\?v=[0-9a-f]{16}$/,
	)
	expect(
		await getPlatformOauthAppLogoObject({ env, logoKey: withLogo.logoKey! }),
	).not.toBeNull()

	const cleared = await setLogo(null)
	expect(cleared.logoKey).toBeNull()
	expect(cleared.logoContentType).toBeNull()
	expect(r2.objects.size).toBe(0)
	expect(buildPlatformOauthAppLogoPath(cleared)).toBeNull()

	await expect(
		setLogo(new Uint8Array([0x00, 0x01, 0x02, 0x03])),
	).rejects.toThrow('must be SVG, PNG, JPEG, or WebP')
	await expect(setLogo(tinyPngBytes, 'missing')).rejects.toThrow(
		'was not found',
	)

	await setLogo(tinyPngBytes)
	const updated = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...githubApp, enabled: false },
	})
	expect(updated.logoKey).toMatch(/^platform-oauth-app-logos\/github\//)
	expect(
		buildPlatformOauthAppLogoPath({
			slug: 'openai.com',
			logoKey: 'platform-oauth-app-logos/openai.com/0123456789abcdef.webp',
		}),
	).toBe('/integrations/logos/openai%2Ecom?v=0123456789abcdef')
})

test('serving an unfitted logo rewrites it to the current WebP ingest', async () => {
	const { env, r2, readApp, storeLogo, loadFitted } = await createHarness()
	await env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await storeLogo(previousKey, 'image/png')
	const stale = await readApp()
	expect(stale?.logoKey).toBe(previousKey)

	const served = await loadFitted(stale)
	expect(served?.contentType).toBe('image/webp')
	expect(served?.cacheControl).toBe('public, max-age=31536000, immutable')
	expect(r2.objects.has(previousKey)).toBe(false)
	expect(r2.objects.size).toBe(1)
	const [fittedKey, fitted] = [...r2.objects.entries()][0]!
	expect(fittedKey).toMatch(fittedKeyPattern)
	expect(fitted.bytes).toEqual(tinyWebpBytes)
	expect(logoNeedsIconFit(fitted.customMetadata)).toBe(false)
})

test('lazy refit does not overwrite a newer logo key', async () => {
	const { env, r2, readApp, storeLogo, loadFitted } = await createHarness()
	const newerKey = 'platform-oauth-app-logos/github/bbbbbbbbbbbbbbbb.webp'
	await env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await env.COMMUNITY_ASSETS.put(newerKey, tinyWebpBytes, {
		httpMetadata: { contentType: 'image/webp' },
		customMetadata: iconFitCustomMetadata(),
	})
	await storeLogo(previousKey, 'image/png')
	const stale = await readApp()
	await storeLogo(newerKey, 'image/webp')

	const served = await loadFitted(stale)
	expect(served?.contentType).toBe('image/webp')
	expect((await readApp())?.logoKey).toBe(newerKey)
	expect(r2.objects.has(newerKey)).toBe(true)
})
