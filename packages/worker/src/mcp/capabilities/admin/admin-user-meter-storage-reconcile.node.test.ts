import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	d1StorageReconciliationBatchSize: 8,
	reconcileD1StorageBytes: vi.fn(async () => ({
		scanned: 2,
		updated: 1,
		failed: 1,
	})),
	logAuditEvent: vi.fn(async () => undefined),
}))

vi.mock('#worker/entitlements/d1-storage-reconciliation.ts', () => ({
	d1StorageReconciliationBatchSize: mockModule.d1StorageReconciliationBatchSize,
	reconcileD1StorageBytes: (...args: Array<unknown>) =>
		mockModule.reconcileD1StorageBytes(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const { adminDomain } = await import('./domain.ts')
const { adminUserMeterStorageReconcileCapability } =
	await import('./admin-user-meter-storage-reconcile.ts')

function createAdminContext(env: Env) {
	return {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
}

test('admin_user_meter_storage_reconcile is registered admin-only mutating maintenance with reconcile keywords', () => {
	const capability = adminDomain.capabilities.find(
		(entry) => entry.name === 'admin_user_meter_storage_reconcile',
	)
	expect(capability).toMatchObject({
		requiredRole: 'admin',
		readOnly: false,
		idempotent: false,
		destructive: false,
	})
	expect(adminDomain.keywords).toEqual(
		expect.arrayContaining(['reconcile', 'storage bytes']),
	)
	expect(adminUserMeterStorageReconcileCapability.name).toBe(
		'admin_user_meter_storage_reconcile',
	)
})

test('admin_user_meter_storage_reconcile passes env and returns full batch result', async () => {
	mockModule.reconcileD1StorageBytes.mockResolvedValueOnce({
		scanned: 3,
		updated: 2,
		failed: 0,
	})
	const env = { APP_DB: {} as D1Database, USER_METER: {} } as Env
	const ctx = createAdminContext(env)

	const result = await adminUserMeterStorageReconcileCapability.handler(
		{ batch_size: 5 },
		ctx,
	)

	expect(result).toMatchObject({
		scanned: 3,
		updated: 2,
		failed: 0,
		batchSize: 5,
	})
	expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(mockModule.reconcileD1StorageBytes).toHaveBeenCalledWith(
		expect.objectContaining({
			db: env.APP_DB,
			env,
			batchSize: 5,
			now: expect.any(Date),
		}),
	)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_user_meter_storage_reconcile',
			result: 'success',
			reason: 'scanned=3;updated=2;failed=0;batch_size=5',
		}),
	)
})

test('admin_user_meter_storage_reconcile sets completedAt after reconciliation starts', async () => {
	let reconcileNow: Date | undefined
	mockModule.reconcileD1StorageBytes.mockImplementationOnce(
		async (input: { now: Date }) => {
			reconcileNow = input.now
			await new Promise((resolve) => setTimeout(resolve, 5))
			return { scanned: 1, updated: 1, failed: 0 }
		},
	)
	const ctx = createAdminContext({ APP_DB: {} as D1Database } as Env)

	const result = await adminUserMeterStorageReconcileCapability.handler({}, ctx)

	expect(reconcileNow).toBeInstanceOf(Date)
	expect(new Date(result.completedAt).getTime()).toBeGreaterThanOrEqual(
		reconcileNow!.getTime(),
	)
})

test('admin_user_meter_storage_reconcile defaults batch_size and reports row failures without throwing', async () => {
	mockModule.reconcileD1StorageBytes.mockResolvedValueOnce({
		scanned: 5,
		updated: 4,
		failed: 1,
	})
	const ctx = createAdminContext({ APP_DB: {} as D1Database } as Env)

	const result = await adminUserMeterStorageReconcileCapability.handler({}, ctx)

	expect(result).toMatchObject({
		scanned: 5,
		updated: 4,
		failed: 1,
		batchSize: mockModule.d1StorageReconciliationBatchSize,
	})
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_user_meter_storage_reconcile',
			result: 'success',
			reason: `scanned=5;updated=4;failed=1;batch_size=${mockModule.d1StorageReconciliationBatchSize}`,
		}),
	)
})

test('admin_user_meter_storage_reconcile rejects out-of-bounds batch_size', async () => {
	mockModule.reconcileD1StorageBytes.mockClear()
	const ctx = createAdminContext({ APP_DB: {} as D1Database } as Env)

	await expect(
		adminUserMeterStorageReconcileCapability.handler({ batch_size: 0 }, ctx),
	).rejects.toThrow()
	await expect(
		adminUserMeterStorageReconcileCapability.handler({ batch_size: 9 }, ctx),
	).rejects.toThrow()
	expect(mockModule.reconcileD1StorageBytes).not.toHaveBeenCalled()
})
