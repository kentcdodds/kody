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
const userId = 'user-1'
const serverId = 'server-1'
const previousKey = `user-mcp-server-logos/${userId}/${serverId}/aaaaaaaaaaaaaaaa.png`

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
		COMMUNITY_ASSETS: r2.bucket,
		IMAGES: createFakeImagesBinding(),
	} as Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	await insertMcpServerSettingRow({
		db,
		row: {
			id: serverId,
			user_id: userId,
			name: 'linear',
			url: 'https://mcp.linear.app/mcp',
			enabled: true,
			logo_key: null,
			logo_content_type: null,
			logo_source: null,
			favicon_source_host: null,
			usage_mode: 'any' as const,
			allowedPackageIds: [],
			last_error: null,
		},
	})
	const readRow = () => getMcpServerSettingRowById({ db, userId, id: serverId })
	const storeFaviconLogo = (logoKey: string, contentType: string) =>
		db
			.prepare(
				`UPDATE mcp_server_settings
				SET logo_key = ?, logo_content_type = ?, logo_source = 'favicon',
					favicon_source_host = 'linear.app', updated_at = ?
				WHERE user_id = ? AND id = ?`,
			)
			.bind(logoKey, contentType, new Date().toISOString(), userId, serverId)
			.run()
	const loadFitted = (row: Awaited<ReturnType<typeof readRow>>) =>
		loadFittedMcpServerLogo({
			db,
			env,
			userId,
			serverId,
			logoKey: row!.logo_key!,
			logoContentType: row!.logo_content_type,
			logoSource: row!.logo_source,
			faviconSourceHost: row!.favicon_source_host,
		})
	await env.COMMUNITY_ASSETS.put(previousKey, tinyPngBytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await storeFaviconLogo(previousKey, 'image/png')
	return { db, env, r2, readRow, storeFaviconLogo, loadFitted }
}

test('lazy refit of an MCP favicon keeps faviconSourceHost, and a lost same-hash refit race keeps the stored logo', async () => {
	const { db, env, r2, readRow, loadFitted } = await createHarness()
	const served = await loadFitted(await readRow())
	expect(served?.contentType).toBe('image/webp')
	const winner = await readRow()
	expect(winner?.logo_key).toMatch(/\.webp$/)
	expect(winner?.favicon_source_host).toBe('linear.app')
	expect(winner?.logo_source).toBe('favicon')
	expect(
		shouldFetchMcpServerFavicon({
			url: winner!.url,
			logoKey: winner!.logo_key,
			logoSource: winner!.logo_source,
			faviconSourceHost: winner!.favicon_source_host,
		}),
	).toBe(false)

	await setMcpServerLogo({
		db,
		env,
		userId,
		serverId,
		sourceBytes: tinyPngBytes,
		source: 'favicon',
		faviconSourceHost: 'linear.app',
		replaceLogoKey: previousKey,
	})
	const current = await readRow()
	expect(current?.logo_key).toBe(winner?.logo_key)
	expect(r2.objects.has(winner!.logo_key!)).toBe(true)
})

test('lazy refit does not overwrite a newer MCP logo key', async () => {
	const { env, r2, readRow, storeFaviconLogo, loadFitted } =
		await createHarness()
	const newerKey = `user-mcp-server-logos/${userId}/${serverId}/bbbbbbbbbbbbbbbb.webp`
	await env.COMMUNITY_ASSETS.put(newerKey, tinyWebpBytes, {
		httpMetadata: { contentType: 'image/webp' },
		customMetadata: { iconFitVersion: '2' },
	})
	const stale = await readRow()
	await storeFaviconLogo(newerKey, 'image/webp')

	const served = await loadFitted(stale)
	expect(served?.contentType).toBe('image/webp')
	expect((await readRow())?.logo_key).toBe(newerKey)
	expect(r2.objects.has(newerKey)).toBe(true)
})
