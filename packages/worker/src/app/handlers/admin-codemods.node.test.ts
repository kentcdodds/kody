import { beforeEach, expect, test, vi } from 'vitest'
import {
	type PermissionString,
	type RoleName,
} from '#worker/identity/permissions.ts'
import { type PackageCodemodRunStepResult } from '#worker/package-codemods/engine.ts'
import { type PackageCodemodRunRecord } from '#worker/package-codemods/ledger.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import type * as AuditLog from '#worker/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listPackageCodemods: vi.fn(),
	getPackageCodemodById: vi.fn(),
	listPackageCodemodRuns: vi.fn(),
	listPackageCodemodRunItems: vi.fn(),
	getPackageCodemodRunById: vi.fn(),
	runPackageCodemodStep: vi.fn(),
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

vi.mock('#worker/package-codemods/registry.ts', () => ({
	listPackageCodemods: (...args: Array<unknown>) =>
		mockModule.listPackageCodemods(...args),
	getPackageCodemodById: (...args: Array<unknown>) =>
		mockModule.getPackageCodemodById(...args),
}))

vi.mock('#worker/package-codemods/ledger.ts', () => ({
	listPackageCodemodRuns: (...args: Array<unknown>) =>
		mockModule.listPackageCodemodRuns(...args),
	listPackageCodemodRunItems: (...args: Array<unknown>) =>
		mockModule.listPackageCodemodRunItems(...args),
	getPackageCodemodRunById: (...args: Array<unknown>) =>
		mockModule.getPackageCodemodRunById(...args),
}))

vi.mock('#worker/package-codemods/engine.ts', () => ({
	runPackageCodemodStep: (...args: Array<unknown>) =>
		mockModule.runPackageCodemodStep(...args),
}))

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

function createTestEnv() {
	return {
		APP_DB: {
			prepare() {
				throw new Error('APP_DB should not be queried directly in these tests')
			},
		},
	} as unknown as Env
}

const { createAdminCodemodsApiHandler, createAdminCodemodsRunApiHandler } =
	await import('./admin-codemods.ts')

beforeEach(() => {
	vi.clearAllMocks()
	logAuditEventSpy.mockClear()
})

function createGetRequest(search = '') {
	const url = new URL(`https://example.com/admin/codemods.json${search}`)
	return {
		request: new Request(url, {
			method: 'GET',
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url,
	} as never
}

function createRunRequest(body: unknown) {
	const url = new URL('https://example.com/admin/codemods/run.json')
	return {
		request: new Request(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		}),
		params: {},
		url,
	} as never
}

const sampleRun: PackageCodemodRunRecord = {
	id: 'run-1',
	codemodId: '0001-ambient-storage-to-package-storage',
	mode: 'scan',
	scopeUserId: null,
	initiatedByUserId: 'stable-admin',
	filtersJson: '{}',
	status: 'completed',
	revertOfRunId: null,
	createdAt: '2026-07-30T10:00:00.000Z',
	updatedAt: '2026-07-30T10:01:00.000Z',
}

function stubKnownCodemod() {
	mockModule.getPackageCodemodById.mockReturnValue({
		id: '0001-ambient-storage-to-package-storage',
		description: 'Migrate ambient storage imports.',
		detect: () => [],
		transform: () => ({
			files: {},
			changed: false,
			changedPaths: [],
			needsManual: [],
		}),
	})
}

test('admin codemods GET requires admin and returns codemods plus recent runs', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsApiHandler(env)
	mockModule.listPackageCodemods.mockReturnValue([
		{
			id: '0001-ambient-storage-to-package-storage',
			description: 'Migrate ambient storage imports.',
		},
	])
	mockModule.listPackageCodemodRuns.mockResolvedValue([sampleRun])

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler(createGetRequest())
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const forbidden = await handler.handler(createGetRequest())
	expect(forbidden.status).toBe(403)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const response = await handler.handler(createGetRequest())
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		codemods: [
			{
				id: '0001-ambient-storage-to-package-storage',
				description: 'Migrate ambient storage imports.',
			},
		],
		runs: [sampleRun],
	})
	expect(mockModule.listPackageCodemodRuns).toHaveBeenCalledWith(env.APP_DB, {
		limit: 50,
	})
})

test('admin codemods GET with runId returns paged run items', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	mockModule.getPackageCodemodRunById.mockResolvedValue(sampleRun)
	const items = Array.from({ length: 2 }, (_, index) => ({
		id: `item-${index}`,
		runId: 'run-1',
		userId: 'user-a',
		packageId: `pkg-${index}`,
		kodyId: `app-${index}`,
		status: 'detected',
		beforeCommit: null,
		afterCommit: null,
		changedPaths: [],
		findings: [{ path: 'index.ts', message: 'ambient storage' }],
		checkSummaryJson: null,
		error: null,
		createdAt: '2026-07-30T10:00:00.000Z',
		updatedAt: '2026-07-30T10:00:00.000Z',
	}))
	mockModule.listPackageCodemodRunItems.mockResolvedValue(items)

	const response = await handler.handler(
		createGetRequest('?runId=run-1&limit=2&afterId=item-0'),
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		run: sampleRun,
		items,
		nextAfterId: 'item-1',
	})
	expect(mockModule.listPackageCodemodRunItems).toHaveBeenCalledWith(
		env.APP_DB,
		{
			runId: 'run-1',
			afterId: 'item-0',
			limit: 2,
		},
	)
})

test('admin codemods run POST requires admin, audits, and runs one step with fleet scope', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	const stepResult: PackageCodemodRunStepResult = {
		runId: 'run-new',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'scan',
		items: [
			{
				itemId: 'item-1',
				userId: 'user-a',
				packageId: 'pkg-1',
				kodyId: 'demo-app',
				status: 'detected',
				changedPaths: [],
				findings: [{ path: 'app.ts', message: 'ambient storage' }],
				beforeCommit: 'abc',
				afterCommit: null,
				checkSummary: null,
				error: null,
			},
		],
		nextCursor: null,
		summary: { detected: 1 },
	}
	stubKnownCodemod()
	mockModule.runPackageCodemodStep.mockResolvedValue(stepResult)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope: 'fleet',
		}),
	)
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const forbidden = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope: 'fleet',
		}),
	)
	expect(forbidden.status).toBe(403)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const response = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope: 'fleet',
			filters: { packageIds: ['pkg-1'] },
		}),
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		...stepResult,
	})
	expect(mockModule.runPackageCodemodStep).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'stable-admin',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'scan',
		scope: { kind: 'fleet' },
		filters: { packageIds: ['pkg-1'] },
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'package_codemod_run_step',
			result: 'success',
			email: 'admin@example.com',
			ip: '127.0.0.1',
			path: '/admin/codemods/run.json',
			reason:
				'codemod_id=0001-ambient-storage-to-package-storage;mode=scan;scope=fleet;run_id=run-new;next_cursor=null;item_count=1',
		}),
	)
})

test('admin codemods run POST requires explicit scope for apply and revert', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	stubKnownCodemod()

	const missingApplyScope = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'apply',
		}),
	)
	expect(missingApplyScope.status).toBe(400)
	await expect(missingApplyScope.json()).resolves.toMatchObject({
		ok: false,
		error: 'scope is required for apply and revert modes.',
	})

	const missingRevertScope = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
			revertOfRunId: 'run-1',
		}),
	)
	expect(missingRevertScope.status).toBe(400)
	await expect(missingRevertScope.json()).resolves.toMatchObject({
		ok: false,
		error: 'scope is required for apply and revert modes.',
	})
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('admin codemods run POST rejects invalid mode and missing revertOfRunId', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	stubKnownCodemod()

	const invalidMode = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'explode',
			scope: 'fleet',
		}),
	)
	expect(invalidMode.status).toBe(400)
	await expect(invalidMode.json()).resolves.toMatchObject({
		ok: false,
		error: 'mode must be one of scan, dry-run, apply, or revert.',
	})

	const missingRevert = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
			scope: 'fleet',
		}),
	)
	expect(missingRevert.status).toBe(400)
	await expect(missingRevert.json()).resolves.toMatchObject({
		ok: false,
		error: 'revert mode requires revertOfRunId.',
	})
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()
})

test('admin codemods run POST rejects revert with bare runId in place of revertOfRunId', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	stubKnownCodemod()

	const response = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
			scope: 'fleet',
			runId: 'run-1',
		}),
	)
	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: 'revert mode requires revertOfRunId.',
	})
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()
})

test('admin codemods run POST rejects supplied-but-empty filters and allows omitted filters', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	stubKnownCodemod()
	mockModule.runPackageCodemodStep.mockResolvedValue({
		runId: 'run-scan',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'scan',
		items: [],
		nextCursor: null,
		summary: {},
	})

	const blankPackageIds = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope: 'fleet',
			filters: { packageIds: ['   '] },
		}),
	)
	expect(blankPackageIds.status).toBe(400)
	await expect(blankPackageIds.json()).resolves.toMatchObject({
		ok: false,
		error:
			'filters.packageIds was supplied but contained no usable ids. Omit the key, or provide at least one non-empty id.',
	})

	const emptyUserIds = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope: 'fleet',
			filters: { userIds: [] },
		}),
	)
	expect(emptyUserIds.status).toBe(400)
	await expect(emptyUserIds.json()).resolves.toMatchObject({
		ok: false,
		error:
			'filters.userIds was supplied but contained no usable ids. Omit the key, or provide at least one non-empty id.',
	})
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()

	const omittedFilters = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope: 'fleet',
		}),
	)
	expect(omittedFilters.status).toBe(200)
	const omittedCall = mockModule.runPackageCodemodStep.mock.calls.at(-1)?.[0] as
		| { filters?: unknown }
		| undefined
	expect(omittedCall).toBeDefined()
	expect(omittedCall).not.toHaveProperty('filters')
})
