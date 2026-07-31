import { expect, test, vi } from 'vitest'
import {
	type PermissionString,
	type RoleName,
} from '#worker/identity/permissions.ts'
import type * as PackageStorageAuditService from '#worker/package-storage-audit/service.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	buildPackageStorageAuditReport: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/package-storage-audit/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageStorageAuditService>()
	return {
		...actual,
		buildPackageStorageAuditReport: (...args: Array<unknown>) =>
			mockModule.buildPackageStorageAuditReport(...args),
	}
})

function createAdminActor(roles: Array<RoleName>) {
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
			userId: 'stable-admin',
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

const { createAdminPackageStorageAuditApiHandler } =
	await import('./admin-package-storage-audit.ts')

function createHandlerRequest(
	input: { limit?: number; startAfter?: string } = {},
) {
	const url = new URL('https://example.com/admin/package-storage-audit.json')
	if (input.limit !== undefined) {
		url.searchParams.set('limit', String(input.limit))
	}
	if (input.startAfter !== undefined) {
		url.searchParams.set('startAfter', input.startAfter)
	}
	return {
		request: new Request(url, {
			method: 'GET',
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url,
	} as never
}

test('admin package storage audit route requires admin and returns the report JSON', async () => {
	const env = { APP_DB: {} } as unknown as Env
	const handler = createAdminPackageStorageAuditApiHandler(env)
	const report = {
		ok: true as const,
		legacyBuckets: [],
		nextStartAfter: null,
		totals: {
			legacyBuckets: 0,
			nonEmptyLegacyBuckets: 0,
			probeErrors: 0,
			truncated: false,
		},
	}

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler(createHandlerRequest())
	expect(unauthorized.status).toBe(401)
	expect(mockModule.buildPackageStorageAuditReport).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const forbidden = await handler.handler(createHandlerRequest())
	expect(forbidden.status).toBe(403)
	expect(mockModule.buildPackageStorageAuditReport).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	mockModule.buildPackageStorageAuditReport.mockResolvedValue(report)

	const cursor = JSON.stringify({ userId: 'user-a', packageId: 'pkg-1' })
	const response = await handler.handler(
		createHandlerRequest({ limit: 50, startAfter: cursor }),
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual(report)
	expect(mockModule.buildPackageStorageAuditReport).toHaveBeenCalledWith({
		env,
		limit: 50,
		startAfter: cursor,
	})
})

test('admin package storage audit route clamps limit and applies the default', async () => {
	const env = { APP_DB: {} } as unknown as Env
	const handler = createAdminPackageStorageAuditApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	mockModule.buildPackageStorageAuditReport.mockResolvedValue({
		ok: true,
		legacyBuckets: [],
		nextStartAfter: null,
		totals: {
			legacyBuckets: 0,
			nonEmptyLegacyBuckets: 0,
			probeErrors: 0,
			truncated: false,
		},
	})

	await handler.handler(createHandlerRequest({ limit: 9999 }))
	expect(mockModule.buildPackageStorageAuditReport).toHaveBeenLastCalledWith(
		expect.objectContaining({ limit: 500, startAfter: null }),
	)

	await handler.handler(createHandlerRequest())
	expect(mockModule.buildPackageStorageAuditReport).toHaveBeenLastCalledWith(
		expect.objectContaining({ limit: 200, startAfter: null }),
	)
})
