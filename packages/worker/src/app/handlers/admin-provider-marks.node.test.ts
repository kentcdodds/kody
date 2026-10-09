import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { RequestContext } from 'remix/router'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { expect, test, vi } from 'vitest'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
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
	readAuthenticatedAppUser:
		vi.fn<typeof AuthenticatedUser.readAuthenticatedAppUser>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
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

function createActor(
	roles: Array<RoleName>,
): AuthenticatedUser.AuthenticatedAppUser {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: personIdFromStored('1'.padStart(64, '0')),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
		request: sessionRequestContext('1'.padStart(64, '0')),
	}
}

function createMarksClient() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const images = createFakeImagesBinding()
	const communityAssets = {
		async put() {},
		async get() {
			return null
		},
		async delete() {},
	}
	const createEnv = (storage: boolean) =>
		({
			APP_DB: db,
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			COMMUNITY_ASSETS: storage ? communityAssets : undefined,
			IMAGES: images,
		}) as unknown as Env
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const url = new URL('https://example.com/admin/provider-marks.json')
	const call = (
		body?: Record<string, unknown>,
		{ storage = true }: { storage?: boolean } = {},
	) =>
		createAdminProviderMarksApiHandler(createEnv(storage)).handler(
			new RequestContext(
				body
					? new Request(url, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(body),
						})
					: new Request(url),
			),
		)
	const listSlugs = async () => {
		const response = await call()
		expect(response.status).toBe(200)
		const body = (await response.json()) as { marks: Array<{ slug: string }> }
		return body.marks.map((mark) => mark.slug)
	}
	return { call, listSlugs }
}

const saveGoogle = {
	action: 'save',
	slug: 'google',
	label: 'Google',
	aliases: ['accounts.google.com'],
	logoBase64: bytesToBase64(tinyPngBytes),
}

test('admin provider marks API saves, lists, and deletes marks, refusing logo writes without storage', async () => {
	const { call, listSlugs } = createMarksClient()

	const noStorageSave = await call(saveGoogle, { storage: false })
	expect(noStorageSave.status).toBe(503)
	expect(await listSlugs()).toEqual([])

	const saved = await call(saveGoogle)
	expect(saved.status).toBe(200)
	const savedBody = (await saved.json()) as {
		ok: true
		marks: Array<{ slug: string; logoPath: string | null }>
	}
	expect(savedBody.marks[0]?.slug).toBe('google')
	expect(savedBody.marks[0]?.logoPath).toMatch(
		/^\/integrations\/provider-marks\/google/,
	)

	const relabeled = await call(
		{ action: 'save', slug: 'google', label: 'Google Accounts' },
		{ storage: false },
	)
	expect(relabeled.status).toBe(200)
	await expect(relabeled.json()).resolves.toMatchObject({
		marks: [
			{
				slug: 'google',
				label: 'Google Accounts',
				logoPath: savedBody.marks[0]?.logoPath,
			},
		],
	})

	const deleteGoogle = { action: 'delete', slug: 'google' }
	const noStorageDelete = await call(deleteGoogle, { storage: false })
	expect(noStorageDelete.status).toBe(503)
	expect(await listSlugs()).toEqual(['google'])

	const deleted = await call(deleteGoogle)
	expect(deleted.status).toBe(200)
	await expect(deleted.json()).resolves.toMatchObject({ ok: true, marks: [] })
})
