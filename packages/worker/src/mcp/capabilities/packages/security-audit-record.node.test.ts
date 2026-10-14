import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	loadCapabilityApprovalSummary: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	insertPackageSecurityAudit: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
}))

vi.mock(
	'#worker/package-capabilities/security-audits-repo.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		insertPackageSecurityAudit: (...args: Array<unknown>) =>
			mockModule.insertPackageSecurityAudit(...args),
	}),
)

const { packageSecurityAuditRecordCapability } =
	await import('./security-audit-record.ts')

const publishedCommit = '34f338c19f91c698c3a28edd2992e0ab87dcb4e0'
const fingerprint = 'fp-current'

function createCtx(userId = 'user-1') {
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: userId,
		ownerScope: 'user',
		ownerEmail: 'user@example.com',
		actorUserId: userId,
	})
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			oauthClientId: 'client-1',
			user: {
				userId: personIdFromStored(userId),
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

function createSavedPackage() {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		kodyId: 'notes',
		name: '@user/notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		hasApp: true,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		sourceId: 'source-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

function mockCurrentVersion(commit: string | null = publishedCommit) {
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: commit,
		capabilitySet: { entries: [], fingerprint },
	})
	mockModule.insertPackageSecurityAudit.mockImplementation(
		async (_db: unknown, record: Record<string, unknown>) => ({
			...record,
			createdAt: record['recordedAt'],
		}),
	)
}

const validArgs = {
	package_id: 'pkg-1',
	published_commit: publishedCommit,
	fingerprint,
	verdict: 'pass' as const,
	summary: 'Only FATHOM_API_KEY, only sent to api.usefathom.com.',
	auditor: 'Audit Agent',
}

test('packageSecurityAuditRecord stores the audit for the current version, audit-logs it, and approves nothing', async () => {
	mockCurrentVersion()

	const result = await packageSecurityAuditRecordCapability.handler(
		validArgs,
		createCtx(),
	)

	expect(result).toEqual({
		ok: true,
		audit_id: expect.any(String),
		package_id: 'pkg-1',
		published_commit: publishedCommit,
		fingerprint,
		verdict: 'pass',
		recorded_at: expect.any(String),
		audit_url:
			'https://heykody.dev/@user/notes/approve-capabilities#security-audit',
	})
	expect(mockModule.insertPackageSecurityAudit).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			packageId: 'pkg-1',
			ownerUserId: 'user-1',
			publishedCommit,
			fingerprint,
			verdict: 'pass',
			summary: validArgs.summary,
			auditorLabel: 'Audit Agent',
			recordedByUserId: 'user-1',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'package_security_audit_record',
			result: 'success',
			email: 'user@example.com',
			clientId: 'client-1',
			reason: expect.stringContaining(
				`package_id=pkg-1;published_commit=${publishedCommit};fingerprint=${fingerprint};verdict=pass`,
			),
		}),
	)
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
})

test('packageSecurityAuditRecord leaves the auditor blank so the page credits the recorder', async () => {
	mockCurrentVersion()

	await packageSecurityAuditRecordCapability.handler(
		{ ...validArgs, auditor: '  ' },
		createCtx(),
	)

	expect(mockModule.insertPackageSecurityAudit).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ auditorLabel: null }),
	)
})

test('packageSecurityAuditRecord rejects an audit of a stale commit or capability set', async () => {
	mockCurrentVersion()

	for (const args of [
		{ ...validArgs, published_commit: 'old-commit' },
		{ ...validArgs, fingerprint: 'fp-old' },
	]) {
		const error = await packageSecurityAuditRecordCapability
			.handler(args, createCtx())
			.catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(McpCallerError)
		expect(error).toMatchObject({
			message: expect.stringContaining(
				`Re-audit the current version and record it with those values.`,
			),
		})
		expect(error).toMatchObject({
			message: expect.stringContaining(publishedCommit),
		})
	}
	expect(mockModule.insertPackageSecurityAudit).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('packageSecurityAuditRecord refuses unpublished and missing packages', async () => {
	mockCurrentVersion(null)
	await expect(
		packageSecurityAuditRecordCapability.handler(validArgs, createCtx()),
	).rejects.toThrow(/has no published version to audit/)

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	await expect(
		packageSecurityAuditRecordCapability.handler(validArgs, createCtx()),
	).rejects.toThrow(/not found/i)

	expect(mockModule.insertPackageSecurityAudit).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})
