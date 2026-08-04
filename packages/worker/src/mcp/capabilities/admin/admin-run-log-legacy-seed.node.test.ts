import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import type * as RunLogLegacySeed from '#worker/admin/run-log-legacy-seed.ts'
import {
	adminRunLogLegacySeedActivationMaxMilestones,
	adminRunLogLegacySeedActivationMaxPackages,
	adminRunLogLegacySeedDefaultUserLimit,
	adminRunLogLegacySeedDefaultWorkflowImportPageSize,
	adminRunLogLegacySeedMaxUserLimit,
} from '#worker/admin/run-log-legacy-seed.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { emptyLegacyParityBucketCounts } from '#worker/run-records/legacy-parity.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn(async () => undefined),
	runAdminRunLogLegacySeed: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#worker/admin/run-log-legacy-seed.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RunLogLegacySeed>()
	return {
		...actual,
		runAdminRunLogLegacySeed: (...args: Array<unknown>) =>
			mockModule.runAdminRunLogLegacySeed(...args),
	}
})

const { adminRunLogLegacySeedCapability } =
	await import('./admin-run-log-legacy-seed.ts')

const targetUserId = testStableUserIdFromEmail('runlog-target@example.com')

const sampleResult = {
	action: 'status' as const,
	generatedAt: '2026-08-03T12:00:00.000Z',
	users: [
		{
			stableUserId: targetUserId,
			failed: false,
			failureStage: null,
			failurePhase: null,
			parity: true,
			activationInitialized: true,
			workflows: emptyLegacyParityBucketCounts(),
			jobs: emptyLegacyParityBucketCounts(),
			activationPackages: emptyLegacyParityBucketCounts(),
			activationMilestones: emptyLegacyParityBucketCounts(),
		},
	],
	usersAttempted: 1,
	usersAtParity: 1,
	nextStartAfter: null,
	truncated: false,
}

function createAdminCtx() {
	return {
		env: {
			APP_DB: {} as D1Database,
			RUN_LOG: {} as DurableObjectNamespace,
			AUDIT_DB: {} as D1Database,
		} as Env,
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

test('admin_run_log_legacy_seed routes status and seed with audits', async () => {
	mockModule.runAdminRunLogLegacySeed.mockResolvedValueOnce(sampleResult)
	mockModule.runAdminRunLogLegacySeed.mockResolvedValueOnce({
		...sampleResult,
		action: 'seed',
		truncated: true,
		nextStartAfter: targetUserId,
		usersAttempted: 5,
		usersAtParity: 4,
	})
	const ctx = createAdminCtx()

	const status = await adminRunLogLegacySeedCapability.handler(
		{ action: 'status' },
		ctx,
	)
	expect(status).toMatchObject({ action: 'status', usersAtParity: 1 })
	expect(mockModule.runAdminRunLogLegacySeed).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'status',
			limit: undefined,
			startAfterUserId: undefined,
		}),
	)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_run_log_legacy_seed',
			result: 'success',
			reason: 'action=status;attempted=1;at_parity=1;truncated=0',
		}),
	)

	const seed = await adminRunLogLegacySeedCapability.handler(
		{
			action: 'seed',
			limit: 5,
			start_after_user_id: targetUserId,
		},
		ctx,
	)
	expect(seed).toMatchObject({
		action: 'seed',
		truncated: true,
		nextStartAfter: targetUserId,
	})
	expect(mockModule.runAdminRunLogLegacySeed).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'seed',
			limit: 5,
			startAfterUserId: targetUserId,
		}),
	)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_run_log_legacy_seed',
			result: 'success',
			reason: 'action=seed;attempted=5;at_parity=4;truncated=1',
		}),
	)

	const serialized = JSON.stringify({ status, seed })
	expect(serialized).not.toContain('secret')
	expect(serialized).not.toContain('workflowName')
	expect(serialized).not.toContain('packageId')
	expect(serialized).not.toContain('jobId')
})

test('admin_run_log_legacy_seed rejects unknown actions and oversized limits', async () => {
	const ctx = createAdminCtx()
	await expect(
		adminRunLogLegacySeedCapability.handler({ action: 'delete' }, ctx),
	).rejects.toThrow()
	await expect(
		adminRunLogLegacySeedCapability.handler(
			{
				action: 'status',
				limit: adminRunLogLegacySeedMaxUserLimit + 1,
			},
			ctx,
		),
	).rejects.toThrow()
	expect(adminRunLogLegacySeedDefaultUserLimit).toBeLessThanOrEqual(
		adminRunLogLegacySeedMaxUserLimit,
	)
})

test('admin_run_log_legacy_seed audits failures without exposing injected error content in reason beyond message', async () => {
	mockModule.runAdminRunLogLegacySeed.mockRejectedValueOnce(
		new Error('boom-run-log-legacy-seed'),
	)
	const ctx = createAdminCtx()
	await expect(
		adminRunLogLegacySeedCapability.handler({ action: 'seed' }, ctx),
	).rejects.toThrow(/boom-run-log-legacy-seed/)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_run_log_legacy_seed',
			result: 'failure',
			reason: 'boom-run-log-legacy-seed',
		}),
	)
})

test('admin_run_log_legacy_seed capability access is admin mutation (combined status+seed)', () => {
	expect(adminRunLogLegacySeedCapability.requiredRole).toBe('admin')
	expect(adminRunLogLegacySeedCapability.readOnly).toBe(false)
	expect(adminRunLogLegacySeedCapability.destructive).toBe(false)
})

test('admin_run_log_legacy_seed description states bounded one-shot activation', () => {
	const description = adminRunLogLegacySeedCapability.description
	expect(description).toContain('bounded one-shot snapshot')
	expect(description).toContain(
		String(adminRunLogLegacySeedActivationMaxPackages),
	)
	expect(description).toContain(
		String(adminRunLogLegacySeedActivationMaxMilestones),
	)
	expect(description).toContain(
		`max ${adminRunLogLegacySeedMaxUserLimit} users/call`,
	)
	expect(description).toContain(
		`default ${adminRunLogLegacySeedDefaultUserLimit}`,
	)
	expect(description).toContain(
		String(adminRunLogLegacySeedDefaultWorkflowImportPageSize),
	)
})

test('admin_run_log_legacy_seed output schema declares failureStage and failurePhase', () => {
	const outputType = adminRunLogLegacySeedCapability.outputTypeDefinition ?? ''
	expect(outputType).toContain('failureStage')
	expect(outputType).toContain('failurePhase')
	expect(outputType).toContain('workflow_inventory')
	expect(outputType).toContain('job_inventory')
	expect(outputType).toContain('activation_inventory')
	expect(outputType).toMatch(/failureStage.*null|null.*failureStage/s)
})

test('admin_run_log_legacy_seed description mentions failureStage diagnostics', () => {
	const description = adminRunLogLegacySeedCapability.description
	expect(description).toContain('failureStage')
	expect(description).toContain('failurePhase')
})
