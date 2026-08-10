import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildPlatformOauthAppLogoPath,
	getPlatformOauthAppLogoObject,
	setPlatformOauthAppLogo,
} from './platform-app-logo.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

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
		/^platform-oauth-app-logos\/github\/[0-9a-f]{16}\.png$/,
	)
	expect(withLogo.logoContentType).toBe('image/png')
	expect(harness.r2.objects.size).toBe(1)
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
