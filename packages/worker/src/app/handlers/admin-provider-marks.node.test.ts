import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
} from '#worker/test-support/images-binding.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

const { createAdminProviderMarksApiHandler } =
	await import('./admin-provider-marks.ts')

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

function createActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: '1'.padStart(64, '0'),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: {
			async put() {},
			async get() {
				return null
			},
			async delete() {},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	return { env }
}

function postRequest(body: Record<string, unknown>) {
	return new Request('https://example.com/admin/provider-marks.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

test('admin provider marks API saves and lists operator marks', async () => {
	const { env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminProviderMarksApiHandler(env)

	const saved = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'google',
			label: 'Google',
			aliases: ['accounts.google.com'],
			logoBase64: bytesToBase64(tinyPngBytes),
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(saved.status).toBe(200)
	const savedBody = (await saved.json()) as {
		ok: true
		marks: Array<{ slug: string; logoPath: string | null }>
	}
	expect(savedBody.marks[0]?.slug).toBe('google')
	expect(savedBody.marks[0]?.logoPath).toMatch(
		/^\/integrations\/provider-marks\/google/,
	)

	const listed = await handler.handler({
		request: new Request('https://example.com/admin/provider-marks.json'),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(listed.status).toBe(200)

	const deleted = await handler.handler({
		request: postRequest({
			action: 'delete',
			slug: 'google',
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(deleted.status).toBe(200)
	const deletedBody = (await deleted.json()) as {
		ok: true
		marks: Array<{ slug: string }>
	}
	expect(deletedBody.marks).toEqual([])
})

test('admin provider marks API rejects a logo write when storage is missing without creating the mark', async () => {
	const { env } = createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminProviderMarksApiHandler({
		...env,
		COMMUNITY_ASSETS: undefined,
	} as Env)

	const saved = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'google',
			label: 'Google',
			logoBase64: bytesToBase64(tinyPngBytes),
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(saved.status).toBe(503)

	const listed = await createAdminProviderMarksApiHandler(env).handler({
		request: new Request('https://example.com/admin/provider-marks.json'),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	const listedBody = (await listed.json()) as {
		ok: true
		marks: Array<{ slug: string }>
	}
	expect(listedBody.marks).toEqual([])
})
