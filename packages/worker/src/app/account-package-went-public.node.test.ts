import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getPackageApprovalRequest: vi.fn(),
	listPendingPackageApprovalRequests: vi.fn(),
	resolvePackageApprovalRequest: vi.fn(),
	loadCapabilityApprovalSummary: vi.fn(),
	findPackageCapabilityApprovalByFingerprint: vi.fn(),
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
	getEntitySourceById: vi.fn(),
	enqueueWentPublicApproval: vi.fn(),
}))

vi.mock('#worker/package-capabilities/approval-requests-repo.ts', () => ({
	getPackageApprovalRequest: (...args: Array<unknown>) =>
		mockModule.getPackageApprovalRequest(...args),
	listPendingPackageApprovalRequests: (...args: Array<unknown>) =>
		mockModule.listPendingPackageApprovalRequests(...args),
	resolvePackageApprovalRequest: (...args: Array<unknown>) =>
		mockModule.resolvePackageApprovalRequest(...args),
}))

vi.mock('#worker/package-capabilities/capability-approvals-repo.ts', () => ({
	findPackageCapabilityApprovalByFingerprint: (...args: Array<unknown>) =>
		mockModule.findPackageCapabilityApprovalByFingerprint(...args),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
}))

vi.mock('#worker/package-capabilities/went-public-approval.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/package-capabilities/went-public-approval.ts')
	>('#worker/package-capabilities/went-public-approval.ts')
	return {
		...actual,
		enqueueWentPublicApproval: (...args: Array<unknown>) =>
			mockModule.enqueueWentPublicApproval(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

const { approveWentPublicRequest, loadPendingPackageApprovals } =
	await import('./account-package-approval-requests.ts')

beforeEach(() => {
	mockModule.getPackageApprovalRequest.mockReset()
	mockModule.listPendingPackageApprovalRequests.mockReset()
	mockModule.resolvePackageApprovalRequest.mockReset()
	mockModule.loadCapabilityApprovalSummary.mockReset()
	mockModule.findPackageCapabilityApprovalByFingerprint.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.updateSavedPackage.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.enqueueWentPublicApproval.mockReset()
})

function stubApproveWentPublicHappyPath() {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'deadbeef',
	})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'deadbeef',
		fingerprintMatchesApproval: true,
		capabilitySet: { fingerprint: 'fp-1', entries: [] },
		dependencySnapshot: null,
	})
	mockModule.findPackageCapabilityApprovalByFingerprint.mockResolvedValue({
		id: 'pin-1',
		publishedCommit: 'deadbeef',
		fingerprint: 'fp-1',
		dependencySnapshotJson: '{}',
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage(false))
	mockModule.resolvePackageApprovalRequest.mockResolvedValue(true)
	mockModule.updateSavedPackage.mockResolvedValue(true)
}

function savedPackage(isInternetVisible = false) {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('owner-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: '',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

test('loadPendingPackageApprovals shows went_public reason and approve action', async () => {
	mockModule.listPendingPackageApprovalRequests.mockResolvedValue([
		{
			id: 'req-went',
			reason: 'went_public',
			pendingCommit: 'deadbeef',
			baseCommit: 'deadbeef',
			createdAt: '2026-01-02T00:00:00.000Z',
			details: { summary: 'Serve this package on the public internet.' },
		},
		{
			id: 'req-stale',
			reason: 'went_public',
			pendingCommit: 'old',
			baseCommit: 'old',
			createdAt: '2026-01-01T00:00:00.000Z',
			details: {},
		},
	])
	const pending = await loadPendingPackageApprovals({
		env: { APP_DB: {} } as Env,
		ownerUserId: 'owner-1',
		packageId: 'pkg-1',
		publishedCommit: 'deadbeef',
	})
	expect(pending).toEqual([
		{
			id: 'req-went',
			reason: 'went_public',
			reasonLabel: 'Went public',
			pendingCommit: 'deadbeef',
			createdAt: '2026-01-02T00:00:00.000Z',
			changes: ['Serve this package on the public internet.'],
			approveAction: 'approve-went-public',
		},
	])
})

test('approveWentPublicRequest flips internet-visible when capability pin matches', async () => {
	const env = { APP_DB: {} } as Env
	const request = new Request('https://example.com/approve')
	stubApproveWentPublicHappyPath()
	const pkg = savedPackage(false)

	const result = await approveWentPublicRequest({
		env,
		request,
		savedPackage: pkg,
		ownerUserId: 'owner-1',
		actorUserId: personIdFromStored('actor-1'),
		requestId: 'req-went',
	})
	expect(result).toEqual({ ok: true })
	expect(
		mockModule.findPackageCapabilityApprovalByFingerprint,
	).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({
			publishedCommit: 'deadbeef',
			fingerprint: 'fp-1',
		}),
	)
	expect(mockModule.resolvePackageApprovalRequest).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({
			id: 'req-went',
			status: 'approved',
		}),
	)
	expect(mockModule.updateSavedPackage).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({
			packageId: 'pkg-1',
			isInternetVisible: true,
			expectedUpdatedAt: pkg.updatedAt,
		}),
	)
})

test('approveWentPublicRequest re-queues went_public when clear bumps updated_at after claim', async () => {
	stubApproveWentPublicHappyPath()
	mockModule.updateSavedPackage.mockResolvedValue(false)
	mockModule.enqueueWentPublicApproval.mockResolvedValue({ id: 'req-retry' })

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: personIdFromStored('actor-1'),
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.resolvePackageApprovalRequest).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'req-went',
			status: 'approved',
		}),
	)
	expect(mockModule.updateSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			isInternetVisible: true,
			expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
		}),
	)
	expect(mockModule.enqueueWentPublicApproval).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerUserId: 'owner-1',
			publishedCommit: 'deadbeef',
			fingerprint: 'fp-1',
			requestedByUserId: personIdFromStored('actor-1'),
		}),
	)
})

test('approveWentPublicRequest requires a pin for the current published commit', async () => {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'deadbeef',
	})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'deadbeef',
		fingerprintMatchesApproval: true,
		capabilitySet: { fingerprint: 'fp-1', entries: [] },
	})
	mockModule.findPackageCapabilityApprovalByFingerprint.mockResolvedValue(null)

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: 'actor-1',
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('approveWentPublicRequest supersedes when the published commit moved', async () => {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'newer',
	})
	mockModule.resolvePackageApprovalRequest.mockResolvedValue(true)

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: 'actor-1',
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.resolvePackageApprovalRequest).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ status: 'superseded' }),
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('approveWentPublicRequest requires a matching capability approval', async () => {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'deadbeef',
	})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'deadbeef',
		fingerprintMatchesApproval: false,
		capabilitySet: { fingerprint: 'fp-1', entries: [] },
	})

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: 'actor-1',
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
	expect(
		mockModule.findPackageCapabilityApprovalByFingerprint,
	).not.toHaveBeenCalled()
})
