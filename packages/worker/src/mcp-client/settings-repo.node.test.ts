import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { stringifyMcpServerLastError } from './oauth-settle-error.ts'
import {
	getMcpServerSettingRowById,
	insertMcpServerSettingRow,
	updateMcpServerSettingLastErrorRow,
} from './settings-repo.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

test('mcp_server_settings last_error persists sanitized JSON for the owning user only', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await insertMcpServerSettingRow({
		db,
		row: {
			id: 'server-1',
			user_id: 'user-1',
			name: 'posthog',
			url: 'https://mcp.posthog.com/mcp',
			enabled: true,
			logo_key: null,
			logo_content_type: null,
			logo_source: null,
			favicon_source_host: null,
			usage_mode: 'any',
			allowedPackageIds: [],
			last_error: null,
		},
	})

	const lastError = stringifyMcpServerLastError({
		message:
			"Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, id attempt-1).",
		phase: 'server/discover',
		httpStatus: 403,
		httpBodySnippet: 'insufficient_scope',
		mcpEndpoint: 'https://mcp.posthog.com/mcp',
		resource: 'https://mcp.posthog.com/',
		authServer: 'https://auth.posthog.com/',
		attemptId: 'attempt-1',
		at: '2026-09-08T00:00:00.000Z',
	})

	expect(
		await updateMcpServerSettingLastErrorRow({
			db,
			userId: 'user-2',
			id: 'server-1',
			lastError,
		}),
	).toBe(false)
	expect(
		await updateMcpServerSettingLastErrorRow({
			db,
			userId: 'user-1',
			id: 'server-1',
			lastError,
		}),
	).toBe(true)

	const stored = await getMcpServerSettingRowById({
		db,
		userId: 'user-1',
		id: 'server-1',
	})
	expect(stored?.last_error).toBe(lastError)

	await updateMcpServerSettingLastErrorRow({
		db,
		userId: 'user-1',
		id: 'server-1',
		lastError: null,
	})
	const cleared = await getMcpServerSettingRowById({
		db,
		userId: 'user-1',
		id: 'server-1',
	})
	expect(cleared?.last_error).toBeNull()
})
