import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildPlatformOauthAppLogoPath,
	getPlatformOauthAppLogoObject,
	setPlatformOauthAppLogo,
	sniffPlatformOauthAppLogoFormat,
} from './platform-app-logo.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

// 1x1 transparent PNG.
const tinyPngBytes = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	),
	(character) => character.charCodeAt(0),
)

type StoredObject = {
	bytes: Uint8Array
	httpMetadata?: { contentType?: string }
	httpEtag: string
	size: number
	body: Uint8Array
}

function createInMemoryR2() {
	const objects = new Map<string, StoredObject>()
	const bucket = {
		async put(
			key: string,
			bytes: Uint8Array,
			options?: { httpMetadata?: { contentType?: string } },
		) {
			objects.set(key, {
				bytes,
				...(options?.httpMetadata
					? { httpMetadata: options.httpMetadata }
					: {}),
				httpEtag: `"etag-${objects.size}"`,
				size: bytes.byteLength,
				body: bytes,
			})
		},
		async get(key: string) {
			return objects.get(key) ?? null
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
	} as Pick<Env, 'SECRET_STORE_KEY' | 'COMMUNITY_ASSETS'>
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

test('logo upload stores a content-hashed raster asset and clears replace the old key', async () => {
	const harness = createHarness()
	await provisionApp(harness)

	const withLogo = await setPlatformOauthAppLogo({
		db: harness.db,
		env: harness.env,
		slug: 'github',
		sourceBytes: tinyPngBytes,
	})
	expect(withLogo.logoKey).toMatch(
		/^platform-oauth-app-logos\/github\/[0-9a-f]{16}\.png$/,
	)
	expect(withLogo.logoContentType).toBe('image/png')
	expect(harness.r2.objects.size).toBe(1)

	const logoPath = buildPlatformOauthAppLogoPath(withLogo)
	expect(logoPath).toMatch(/^\/integrations\/logos\/github\?v=[0-9a-f]{16}$/)

	const object = await getPlatformOauthAppLogoObject({
		env: harness.env,
		logoKey: withLogo.logoKey!,
	})
	expect(object).not.toBeNull()

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
})

test('app upserts never touch logo columns (retain-on-omit like the secret)', async () => {
	const harness = createHarness()
	await provisionApp(harness)
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

test('sniffing detects raster magic bytes and svg text', () => {
	expect(sniffPlatformOauthAppLogoFormat(tinyPngBytes)).toBe('png')
	expect(
		sniffPlatformOauthAppLogoFormat(
			new TextEncoder().encode('  <svg xmlns="http://www.w3.org/2000/svg"/>'),
		),
	).toBe('svg')
	expect(
		sniffPlatformOauthAppLogoFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
	).toBe('jpeg')
	expect(
		sniffPlatformOauthAppLogoFormat(new Uint8Array([0x00, 0x00, 0x00, 0x00])),
	).toBeNull()
})
