import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AuditLog from '#worker/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	runPackageCodemodStep: vi.fn(),
	getPackageCodemodRunById: vi.fn(),
	logAuditEvent: vi.fn(),
}))

vi.mock('#worker/package-codemods/engine.ts', () => ({
	runPackageCodemodStep: (...args: Array<unknown>) =>
		mockModule.runPackageCodemodStep(...args),
}))

vi.mock('#worker/package-codemods/ledger.ts', () => ({
	getPackageCodemodRunById: (...args: Array<unknown>) =>
		mockModule.getPackageCodemodRunById(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const { adminPackageCodemodApplyCapability } =
	await import('./admin-package-codemod-apply.ts')
const { adminPackageCodemodRevertCapability } =
	await import('./admin-package-codemod-revert.ts')
const { adminPackageCodemodScanCapability } =
	await import('./admin-package-codemod-scan.ts')
const { adminDomain } = await import('./domain.ts')

function createAdminCtx(userId = 'admin-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
}

function emptyStepResult(input: {
	runId: string
	codemodId: string
	mode: 'scan' | 'dry-run' | 'apply' | 'revert'
}) {
	return {
		runId: input.runId,
		codemodId: input.codemodId,
		mode: input.mode,
		items: [],
		nextCursor: null,
		summary: {},
	}
}

test('admin package codemod capabilities are fleet-scoped, audited, and role-gated', async () => {
	const byName = new Map(
		adminDomain.capabilities.map((capability) => [capability.name, capability]),
	)
	expect(byName.get('admin_package_codemod_scan')?.requiredRole).toBe('admin')
	expect(byName.get('admin_package_codemod_scan')?.readOnly).toBe(true)
	expect(byName.get('admin_package_codemod_apply')?.destructive).toBe(true)
	expect(byName.get('admin_package_codemod_revert')?.destructive).toBe(true)
	expect(adminPackageCodemodApplyCapability.destructive).toBe(true)

	mockModule.runPackageCodemodStep.mockResolvedValue(
		emptyStepResult({
			runId: 'fleet-scan-1',
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
		}),
	)
	mockModule.logAuditEvent.mockResolvedValue(undefined)

	await expect(
		adminPackageCodemodScanCapability.handler(
			{
				codemodId: '0001-ambient-storage-to-package-storage',
				filters: { userIds: ['user-a'], packageIds: ['pkg-a'] },
				limit: 5,
			},
			createAdminCtx(),
		),
	).resolves.toMatchObject({ runId: 'fleet-scan-1', mode: 'scan' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		baseUrl: 'https://heykody.dev',
		initiatedByUserId: 'admin-1',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'scan',
		scope: { kind: 'fleet' },
		filters: { userIds: ['user-a'], packageIds: ['pkg-a'] },
		runId: undefined,
		cursor: undefined,
		limit: 5,
		revertOfRunId: undefined,
	})
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_package_codemod_scan',
			result: 'success',
		}),
	)

	mockModule.runPackageCodemodStep.mockResolvedValue(
		emptyStepResult({
			runId: 'fleet-apply-1',
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'apply',
		}),
	)
	await expect(
		adminPackageCodemodApplyCapability.handler(
			{
				codemodId: '0001-ambient-storage-to-package-storage',
				packageIds: ['pkg-canary'],
			},
			createAdminCtx(),
		),
	).resolves.toMatchObject({ mode: 'apply' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith(
		expect.objectContaining({
			mode: 'apply',
			scope: { kind: 'fleet' },
			filters: { packageIds: ['pkg-canary'] },
			initiatedByUserId: 'admin-1',
		}),
	)

	mockModule.getPackageCodemodRunById.mockResolvedValue({
		id: 'fleet-apply-1',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		filtersJson: '{}',
		status: 'completed',
		revertOfRunId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	})
	mockModule.runPackageCodemodStep.mockResolvedValue(
		emptyStepResult({
			runId: 'fleet-revert-1',
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
		}),
	)
	await expect(
		adminPackageCodemodRevertCapability.handler(
			{ revertOfRunId: 'fleet-apply-1' },
			createAdminCtx(),
		),
	).resolves.toMatchObject({ runId: 'fleet-revert-1', mode: 'revert' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith(
		expect.objectContaining({
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
			scope: { kind: 'fleet' },
			revertOfRunId: 'fleet-apply-1',
		}),
	)
})
