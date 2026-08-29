import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'
import { shouldFetchMcpServerFavicon } from './mcp-server-favicon.ts'
import { loadFittedMcpServerLogo, setMcpServerLogo } from './mcp-server-logo.ts'
import {
	getMcpServerSettingRowById,
	insertMcpServerSettingRow,
} from './settings-repo.ts'

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
		COMMUNITY_ASSETS: r2.bucket,
		IMAGES: createFakeImagesBinding(),
	} as Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	return { sqlite, db, env, r2 }
}

async function provisionServer(harness: ReturnType<typeof createHarness>) {
	const row = {
		id: 'server-1',
		user_id: 'user-1',
		name: 'linear',
		url: 'https://mcp.linear.app/mcp',
		enabled: true,
		logo_key: null,
		logo_content_type: null,
		logo_source: null,
		favicon_source_host: null,
		usage_mode: 'any' as const,
		allowedPackageIds: [],
	}
	await insertMcpServerSettingRow({ db: harness.db, row })
	return row
}

test('lazy refit of an MCP favicon keeps faviconSourceHost', async () => {
	const harness = createHarness()
	const server = await provisionServer(harness)
	const previousKey = `user-mcp-server-logos/${server.user_id}/${server.id}/aaaaaaaaaaaaaaaa.png`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.db
		.prepare(
			`UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			previousKey,
			'image/png',
			'favicon',
			'linear.app',
			new Date().toISOString(),
			server.user_id,
			server.id,
		)
		.run()
	const stale = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})

	const served = await loadFittedMcpServerLogo({
		db: harness.db,
		env: harness.env,
		userId: server.user_id,
		serverId: server.id,
		logoKey: stale!.logo_key!,
		logoContentType: stale!.logo_content_type,
		logoSource: stale!.logo_source,
		faviconSourceHost: stale!.favicon_source_host,
	})
	expect(served?.contentType).toBe('image/webp')
	const current = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})
	expect(current?.favicon_source_host).toBe('linear.app')
	expect(current?.logo_source).toBe('favicon')
	expect(
		shouldFetchMcpServerFavicon({
			url: current!.url,
			logoKey: current!.logo_key,
			logoSource: current!.logo_source,
			faviconSourceHost: current!.favicon_source_host,
		}),
	).toBe(false)
})

test('lazy refit does not overwrite a newer MCP logo key', async () => {
	const harness = createHarness()
	const server = await provisionServer(harness)
	const previousKey = `user-mcp-server-logos/${server.user_id}/${server.id}/aaaaaaaaaaaaaaaa.png`
	const newerKey = `user-mcp-server-logos/${server.user_id}/${server.id}/bbbbbbbbbbbbbbbb.webp`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.env.COMMUNITY_ASSETS.put(newerKey, tinyWebpBytes, {
		httpMetadata: { contentType: 'image/webp' },
		customMetadata: { iconFitVersion: '2' },
	})
	await harness.db
		.prepare(
			`UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			previousKey,
			'image/png',
			'favicon',
			'linear.app',
			new Date().toISOString(),
			server.user_id,
			server.id,
		)
		.run()
	const stale = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})
	await harness.db
		.prepare(
			`UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			newerKey,
			'image/webp',
			'favicon',
			'linear.app',
			new Date().toISOString(),
			server.user_id,
			server.id,
		)
		.run()

	const served = await loadFittedMcpServerLogo({
		db: harness.db,
		env: harness.env,
		userId: server.user_id,
		serverId: server.id,
		logoKey: stale!.logo_key!,
		logoContentType: stale!.logo_content_type,
		logoSource: stale!.logo_source,
		faviconSourceHost: stale!.favicon_source_host,
	})
	expect(served?.contentType).toBe('image/webp')
	const current = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})
	expect(current?.logo_key).toBe(newerKey)
	expect(harness.r2.objects.has(newerKey)).toBe(true)
})

test('lost same-hash refit race keeps the stored MCP logo', async () => {
	const harness = createHarness()
	const server = await provisionServer(harness)
	const previousKey = `user-mcp-server-logos/${server.user_id}/${server.id}/aaaaaaaaaaaaaaaa.png`
	await harness.env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await harness.db
		.prepare(
			`UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			previousKey,
			'image/png',
			'favicon',
			'linear.app',
			new Date().toISOString(),
			server.user_id,
			server.id,
		)
		.run()
	const stale = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})
	await loadFittedMcpServerLogo({
		db: harness.db,
		env: harness.env,
		userId: server.user_id,
		serverId: server.id,
		logoKey: stale!.logo_key!,
		logoContentType: stale!.logo_content_type,
		logoSource: stale!.logo_source,
		faviconSourceHost: stale!.favicon_source_host,
	})
	const winner = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})
	expect(winner?.logo_key).toMatch(/\.webp$/)

	await setMcpServerLogo({
		db: harness.db,
		env: harness.env,
		userId: server.user_id,
		serverId: server.id,
		sourceBytes: tinyPngBytes,
		source: 'favicon',
		faviconSourceHost: 'linear.app',
		replaceLogoKey: previousKey,
	})
	const current = await getMcpServerSettingRowById({
		db: harness.db,
		userId: server.user_id,
		id: server.id,
	})
	expect(current?.logo_key).toBe(winner?.logo_key)
	expect(harness.r2.objects.has(winner!.logo_key!)).toBe(true)
})
