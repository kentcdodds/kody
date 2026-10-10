import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
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
	markAbandonedPackageCodemodRuns: vi.fn(),
	updatePackageCodemodRunStatus: vi.fn(),
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
	markAbandonedPackageCodemodRuns: (...args: Array<unknown>) =>
		mockModule.markAbandonedPackageCodemodRuns(...args),
	updatePackageCodemodRunStatus: (...args: Array<unknown>) =>
		mockModule.updatePackageCodemodRunStatus(...args),
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
			userId: ownerIdFromStored('stable-admin'),
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

const {
	createAdminCodemodsApiHandler,
	createAdminCodemodsRunApiHandler,
	createAdminCodemodsRunStopApiHandler,
} = await import('./admin-codemods.ts')

const codemodId = '0001-ambient-storage-to-package-storage'

function createRequest(path: string, body?: unknown) {
	const url = new URL(`https://example.com${path}`)
	return {
		request: new Request(url, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				Accept: 'application/json',
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		params: {},
		url,
	} as never
}

const getCodemods = (
	handler: ReturnType<typeof createAdminCodemodsApiHandler>,
	search = '',
) => handler.handler(createRequest(`/admin/codemods.json${search}`))
const postRun = (
	handler: ReturnType<typeof createAdminCodemodsRunApiHandler>,
	body: unknown,
) => handler.handler(createRequest('/admin/codemods/run.json', body))
const postStop = (
	handler: ReturnType<typeof createAdminCodemodsRunStopApiHandler>,
	body: unknown,
) => handler.handler(createRequest('/admin/codemods/run/stop.json', body))

async function expectAdminGate(send: () => Promise<Response>) {
	for (const [actor, status] of [
		[null, 401],
		[createAdminActor(['user']), 403],
	] as const) {
		mockModule.readAuthenticatedAppUser.mockResolvedValue(actor)
		expect([actor?.roles, (await send()).status]).toEqual([
			actor?.roles,
			status,
		])
	}
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
}

const sampleRun: PackageCodemodRunRecord = {
	id: 'run-1',
	codemodId,
	mode: 'scan',
	scopeUserId: null,
	initiatedByUserId: 'stable-admin',
	filtersJson: '{}',
	status: 'completed',
	revertOfRunId: null,
	createdAt: '2026-07-30T10:00:00.000Z',
	updatedAt: '2026-07-30T10:01:00.000Z',
}

test('admin codemods GET requires admin and returns codemods, recent runs, and paged run items', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsApiHandler(env)
	mockModule.listPackageCodemods.mockReturnValue([
		{ id: codemodId, description: 'Migrate ambient storage imports.' },
	])
	mockModule.listPackageCodemodRuns.mockResolvedValue([sampleRun])
	mockModule.markAbandonedPackageCodemodRuns.mockResolvedValue(0)

	await expectAdminGate(() => getCodemods(handler))
	const response = await getCodemods(handler)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		codemods: [
			{ id: codemodId, description: 'Migrate ambient storage imports.' },
		],
		runs: [sampleRun],
	})
	expect(mockModule.listPackageCodemodRuns).toHaveBeenCalledWith(env.APP_DB, {
		limit: 50,
	})
	const reconcileCall =
		mockModule.markAbandonedPackageCodemodRuns.mock.calls.at(-1) as
			| [unknown, { updatedBefore: string }]
			| undefined
	expect(reconcileCall?.[0]).toBe(env.APP_DB)
	const cutoffMs = Date.parse(reconcileCall![1].updatedBefore)
	expect(Date.now() - cutoffMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1)
	expect(Date.now() - cutoffMs).toBeLessThan(2 * 60 * 60 * 1000)

	mockModule.getPackageCodemodRunById.mockResolvedValue(sampleRun)
	const items = Array.from({ length: 2 }, (_, index) => ({
		id: `item-${index}`,
		runId: 'run-1',
		userId: ownerIdFromStored('user-a'),
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
	const itemsResponse = await getCodemods(
		handler,
		'?runId=run-1&limit=2&afterId=item-0',
	)
	expect(itemsResponse.status).toBe(200)
	await expect(itemsResponse.json()).resolves.toEqual({
		ok: true,
		run: sampleRun,
		items,
		nextAfterId: 'item-1',
	})
	expect(mockModule.listPackageCodemodRunItems).toHaveBeenCalledWith(
		env.APP_DB,
		{ runId: 'run-1', afterId: 'item-0', limit: 2 },
	)
})

test('admin codemods run POST requires admin, rejects invalid requests, audits, and runs one fleet step', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunApiHandler(env)
	const stepResult: PackageCodemodRunStepResult = {
		runId: 'run-new',
		codemodId,
		mode: 'scan',
		items: [
			{
				itemId: 'item-1',
				userId: ownerIdFromStored('user-a'),
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
		id: codemodId,
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

	await expectAdminGate(() =>
		postRun(handler, { codemodId, mode: 'scan', scope: 'fleet' }),
	)

	const badRequests = [
		{ mode: 'apply' },
		{ mode: 'revert', revertOfRunId: 'run-1' },
		{ mode: 'explode', scope: 'fleet' },
		{ mode: 'revert', scope: 'fleet' },
		{ mode: 'revert', scope: 'fleet', runId: 'run-1' },
		{ mode: 'scan', scope: 'fleet', filters: { packageIds: ['   '] } },
		{ mode: 'scan', scope: 'fleet', filters: { userIds: [] } },
	]
	for (const body of badRequests) {
		const response = await postRun(handler, { codemodId, ...body })
		expect([body, response.status, await response.json()]).toEqual([
			body,
			400,
			expect.objectContaining({ ok: false }),
		])
	}
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()

	const omittedFilters = await postRun(handler, {
		codemodId,
		mode: 'scan',
		scope: 'fleet',
	})
	expect(omittedFilters.status).toBe(200)
	const omittedCall = mockModule.runPackageCodemodStep.mock.calls.at(
		-1,
	)?.[0] as { filters?: unknown } | undefined
	expect(omittedCall).toBeDefined()
	expect(omittedCall).not.toHaveProperty('filters')

	const response = await postRun(handler, {
		codemodId,
		mode: 'scan',
		scope: 'fleet',
		filters: { packageIds: ['pkg-1'] },
	})
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({ ok: true, ...stepResult })
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'stable-admin',
		codemodId,
		mode: 'scan',
		scope: { kind: 'fleet' },
		filters: { packageIds: ['pkg-1'] },
	})
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'package_codemod_run_step',
			result: 'success',
			email: 'admin@example.com',
			ip: '127.0.0.1',
			path: '/admin/codemods/run.json',
			reason: `codemod_id=${codemodId};mode=scan;scope=fleet;run_id=run-new;next_cursor=null;item_count=1`,
		}),
	)
})

test('admin codemods stop POST requires admin and marks running runs abandoned', async () => {
	const env = createTestEnv()
	const handler = createAdminCodemodsRunStopApiHandler(env)
	mockModule.updatePackageCodemodRunStatus.mockResolvedValue(undefined)

	await expectAdminGate(() => postStop(handler, { runId: 'run-1' }))

	mockModule.updatePackageCodemodRunStatus.mockResolvedValue(1)
	expect((await postStop(handler, {})).status).toBe(400)

	mockModule.getPackageCodemodRunById.mockResolvedValue(null)
	expect((await postStop(handler, { runId: 'run-missing' })).status).toBe(404)

	mockModule.getPackageCodemodRunById.mockResolvedValue({
		...sampleRun,
		status: 'completed',
	})
	const alreadyTerminal = await postStop(handler, { runId: 'run-1' })
	expect(alreadyTerminal.status).toBe(200)
	await expect(alreadyTerminal.json()).resolves.toEqual({
		ok: true,
		runId: 'run-1',
		status: 'completed',
	})
	expect(mockModule.updatePackageCodemodRunStatus).not.toHaveBeenCalled()

	mockModule.getPackageCodemodRunById.mockResolvedValue({
		...sampleRun,
		status: 'running',
	})
	const stopped = await postStop(handler, { runId: 'run-1' })
	expect(stopped.status).toBe(200)
	await expect(stopped.json()).resolves.toEqual({
		ok: true,
		runId: 'run-1',
		status: 'abandoned',
	})
	expect(mockModule.updatePackageCodemodRunStatus).toHaveBeenCalledWith(
		env.APP_DB,
		{ id: 'run-1', status: 'abandoned', expectedStatus: 'running' },
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'package_codemod_run_stop',
			result: 'success',
			email: 'admin@example.com',
			path: '/admin/codemods/run/stop.json',
			reason: `run_id=run-1;codemod_id=${codemodId};mode=scan`,
		}),
	)

	// Race: the run completed between the read and the conditional write; the
	// stop endpoint reports the winning status instead of overwriting it.
	logAuditEventSpy.mockClear()
	mockModule.updatePackageCodemodRunStatus.mockResolvedValue(0)
	mockModule.getPackageCodemodRunById
		.mockResolvedValueOnce({ ...sampleRun, status: 'running' })
		.mockResolvedValueOnce({ ...sampleRun, status: 'completed' })
	const lostRace = await postStop(handler, { runId: 'run-1' })
	expect(lostRace.status).toBe(200)
	await expect(lostRace.json()).resolves.toEqual({
		ok: true,
		runId: 'run-1',
		status: 'completed',
	})
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})
