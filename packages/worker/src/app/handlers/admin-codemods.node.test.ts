import { beforeEach, expect, test, vi } from 'vitest'
import {
	type PermissionString,
	type RoleName,
} from '#worker/identity/permissions.ts'
import { type PackageCodemodRunStepResult } from '#worker/package-codemods/engine.ts'
import { type PackageCodemodRunRecord } from '#worker/package-codemods/ledger.ts'

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

test('admin codemods run POST requires admin and runs one step with fleet scope', async () => {
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
	mockModule.runPackageCodemodStep.mockResolvedValue(stepResult)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
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
			filters: { packageIds: ['pkg-1'] },
			limit: 10,
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
		limit: 10,
	})
})

test('admin codemods run POST rejects invalid mode and missing revertOfRunId', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
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

	const invalidMode = await handler.handler(
		createRunRequest({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'explode',
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
		}),
	)
	expect(missingRevert.status).toBe(400)
	await expect(missingRevert.json()).resolves.toMatchObject({
		ok: false,
		error: 'revert mode requires revertOfRunId.',
	})
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()
})
