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
		deferred: 0,
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

test('admin_user_meter_storage_reconcile routes batch size, audits, and rejects OOB', async () => {
	mockModule.reconcileD1StorageBytes.mockResolvedValueOnce({
		scanned: 3,
		updated: 2,
		failed: 0,
		deferred: 1,
	})
	const env = { APP_DB: {} as D1Database, USER_METER: {} } as Env
	const ctx = createAdminContext(env)

	const custom = await adminUserMeterStorageReconcileCapability.handler(
		{ batch_size: 5 },
		ctx,
	)
	expect(custom).toMatchObject({
		scanned: 3,
		updated: 2,
		failed: 0,
		deferred: 1,
		batchSize: 5,
	})
	expect(custom.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
		}),
	)

	mockModule.reconcileD1StorageBytes.mockResolvedValueOnce({
		scanned: 5,
		updated: 4,
		failed: 1,
		deferred: 0,
	})
	const defaults = await adminUserMeterStorageReconcileCapability.handler(
		{},
		ctx,
	)
	expect(defaults).toMatchObject({
		scanned: 5,
		updated: 4,
		failed: 1,
		deferred: 0,
		batchSize: mockModule.d1StorageReconciliationBatchSize,
	})

	mockModule.reconcileD1StorageBytes.mockClear()
	await expect(
		adminUserMeterStorageReconcileCapability.handler({ batch_size: 0 }, ctx),
	).rejects.toThrow()
	await expect(
		adminUserMeterStorageReconcileCapability.handler({ batch_size: 9 }, ctx),
	).rejects.toThrow()
	expect(mockModule.reconcileD1StorageBytes).not.toHaveBeenCalled()
})
