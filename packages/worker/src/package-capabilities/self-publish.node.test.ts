import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import type * as WentPublicApproval from './went-public-approval.ts'

const mockModule = vi.hoisted(() => ({
	isFeatureGloballyEnabled: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	loadPublishedCredentialNeeds: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	getPendingWentPublicApproval: vi.fn(),
	enqueueWentPublicApproval: vi.fn(),
	resolvePackageApprovalRequest: vi.fn(),
	approveWentPublicRequest: vi.fn(),
	logOrgAuditEvent: vi.fn(),
}))

vi.mock('#worker/feature-flags/service.ts', () => ({
	isFeatureGloballyEnabled: (...args: Array<unknown>) =>
		mockModule.isFeatureGloballyEnabled(...args),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))
vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
}))
vi.mock('#worker/credentials/credential-needs-closure.ts', () => ({
	loadPublishedCredentialNeeds: (...args: Array<unknown>) =>
		mockModule.loadPublishedCredentialNeeds(...args),
}))
vi.mock('./capability-approval-service.ts', () => ({
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
}))
vi.mock('./approval-requests-repo.ts', () => ({
	resolvePackageApprovalRequest: (...args: Array<unknown>) =>
		mockModule.resolvePackageApprovalRequest(...args),
}))
vi.mock('./went-public-approval.ts', async (importOriginal) => ({
	...(await importOriginal<typeof WentPublicApproval>()),
	enqueueWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.enqueueWentPublicApproval(...args),
	getPendingWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.getPendingWentPublicApproval(...args),
}))
vi.mock('#app/account-package-approval-requests.ts', () => ({
	approveWentPublicRequest: (...args: Array<unknown>) =>
		mockModule.approveWentPublicRequest(...args),
}))
vi.mock('#worker/orgs/org-audit.ts', () => ({
	logOrgAuditEvent: (...args: Array<unknown>) =>
		mockModule.logOrgAuditEvent(...args),
}))

const { evaluateSelfPublish, selfPublishPackage, selfPublishAuditAction } =
	await import('./self-publish.ts')

const ownerId = ownerIdFromStored('org-1')
const savedPackage = {
	id: 'pkg-1',
	userId: ownerId,
	kodyId: 'landing',
	name: '@bea/landing',
	description: 'Landing page',
	tags: [],
	searchText: null,
	hasApp: true,
	hasSkills: false,
	hidden: false,
	isPrivate: false,
	isInternetVisible: false,
	lockedAt: null,
	sourceId: 'source-root',
	createdAt: '2026-10-01T00:00:00.000Z',
	updatedAt: '2026-10-01T00:00:00.000Z',
}

function summary(dependencySourceIds: Array<string> = []) {
	return {
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		dependencySnapshot: {
			version: 1 as const,
			root: {
				packageId: 'pkg-1',
				kodyId: 'landing',
				sourceId: 'source-root',
				publishedCommit: 'commit-root',
			},
			dependencies: dependencySourceIds.map((sourceId) => ({
				sourceId,
				publishedCommit: `commit-${sourceId}`,
				kodyId: sourceId,
			})),
		},
		publishedCommit: 'commit-root',
		latestApproval: null,
		matchingApproval: null,
		fingerprintMatchesApproval: false,
		isInternetVisible: false,
	}
}

function publishTree(kodyBySource: Record<string, Record<string, unknown>>) {
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			sourceId in kodyBySource
				? {
						id: sourceId,
						user_id: `owner-of-${sourceId}`,
						published_commit: `commit-${sourceId}`,
					}
				: null,
	)
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { sourceId: string }) => ({
			manifest: {
				name: input.sourceId,
				kody: { description: 'test', ...kodyBySource[input.sourceId] },
			},
		}),
	)
}

const env = { APP_DB: {} } as Env

beforeEach(() => {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.isFeatureGloballyEnabled.mockResolvedValue(true)
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([])
	mockModule.logOrgAuditEvent.mockResolvedValue(undefined)
})

test('a tree that declares nothing is eligible, checked per package owner with the fresh closure', async () => {
	publishTree({ 'source-root': {}, 'source-dep': { app: { entry: 'x' } } })
	await expect(
		evaluateSelfPublish({
			env,
			savedPackage,
			summary: summary(['source-dep']),
		}),
	).resolves.toEqual({ eligible: true })
	expect(mockModule.loadPublishedCredentialNeeds.mock.calls).toEqual([
		[
			expect.objectContaining({
				userId: 'owner-of-source-root',
				sourceId: 'source-root',
				fresh: true,
			}),
		],
		[
			expect.objectContaining({
				userId: 'owner-of-source-dep',
				sourceId: 'source-dep',
				fresh: true,
			}),
		],
	])
})

test('self-publish is blocked with enforcement off, credentials, or other capabilities anywhere in the tree', async () => {
	const evaluate = (dependencies: Array<string> = ['source-dep']) =>
		evaluateSelfPublish({ env, savedPackage, summary: summary(dependencies) })

	mockModule.isFeatureGloballyEnabled.mockResolvedValueOnce(false)
	publishTree({ 'source-root': {}, 'source-dep': {} })
	await expect(evaluate()).resolves.toEqual({
		eligible: false,
		blocker: 'enforcement_off',
	})

	publishTree({ 'source-root': {} })
	await expect(evaluate()).resolves.toEqual({
		eligible: false,
		blocker: 'unpublished',
	})

	publishTree({
		'source-root': {},
		'source-dep': { credentials: { resend: { description: 'Mail.' } } },
	})
	await expect(evaluate()).resolves.toEqual({
		eligible: false,
		blocker: 'declares_credentials',
	})

	publishTree({ 'source-root': {}, 'source-dep': {} })
	mockModule.loadPublishedCredentialNeeds.mockImplementation(
		async (input: { sourceId: string }) =>
			input.sourceId === 'source-dep'
				? [{ key: 'resend', provider: 'resend' }]
				: [],
	)
	await expect(evaluate()).resolves.toEqual({
		eligible: false,
		blocker: 'declares_credentials',
	})
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([])

	for (const kody of [
		{ secretMounts: { token: { name: 'TOKEN' } } },
		{ secretProvider: { name: 'vault' } },
		{ subscriptions: { tick: {} } },
		{ emits: { done: { description: 'Done.' } } },
		{ jobs: { nightly: {} } },
		{ retrievers: { docs: {} } },
		{ webhooks: [{ name: 'stripe' }] },
	]) {
		publishTree({ 'source-root': kody, 'source-dep': {} })
		await expect(evaluate()).resolves.toEqual({
			eligible: false,
			blocker: 'declares_capabilities',
		})
	}
})

test('selfPublishPackage pins the set, approves a marked went_public request, and audits once', async () => {
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-1', publishedCommit: 'commit-root' },
	})
	mockModule.getPendingWentPublicApproval.mockResolvedValue({
		id: 'owner-request',
		details: { fingerprint: 'fp-1' },
	})
	mockModule.enqueueWentPublicApproval.mockResolvedValue({ id: 'request-1' })
	mockModule.approveWentPublicRequest.mockResolvedValue({ ok: true })
	const request = sessionRequestContext('person-1', 'bea')

	await expect(
		selfPublishPackage({
			env,
			request,
			requestUrl: 'https://heykody.dev',
			ownerUserId: ownerId,
			actorUserId: 'person-1',
			savedPackage,
			summary: summary(),
		}),
	).resolves.toEqual({ ok: true })

	expect(mockModule.approvePackageCapabilitySet).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedFingerprint: 'fp-1',
			enqueueWentPublic: false,
		}),
	)
	expect(mockModule.resolvePackageApprovalRequest).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({ id: 'owner-request', status: 'superseded' }),
	)
	expect(mockModule.enqueueWentPublicApproval).toHaveBeenCalledWith(
		expect.objectContaining({
			publishedCommit: 'commit-root',
			selfPublish: true,
		}),
	)
	expect(mockModule.approveWentPublicRequest).toHaveBeenCalledWith(
		expect.objectContaining({ requestId: 'request-1' }),
	)
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledTimes(1)
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: selfPublishAuditAction,
			result: 'success',
			orgId: ownerId,
			resourceId: 'pkg-1',
			details: expect.objectContaining({
				requestId: 'request-1',
				approvalId: 'approval-1',
				fingerprint: 'fp-1',
			}),
		}),
	)
})

test('selfPublishPackage audits a failed approve and returns its error', async () => {
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-1', publishedCommit: 'commit-root' },
	})
	mockModule.getPendingWentPublicApproval.mockResolvedValue(null)
	mockModule.enqueueWentPublicApproval.mockResolvedValue({ id: 'request-1' })
	mockModule.approveWentPublicRequest.mockResolvedValue({
		ok: false,
		status: 409,
		error: 'The published version changed.',
	})

	await expect(
		selfPublishPackage({
			env,
			request: sessionRequestContext('person-1', 'bea'),
			requestUrl: 'https://heykody.dev',
			ownerUserId: ownerId,
			actorUserId: 'person-1',
			savedPackage,
			summary: summary(),
		}),
	).resolves.toEqual({ ok: false, error: 'The published version changed.' })
	expect(mockModule.resolvePackageApprovalRequest).not.toHaveBeenCalled()
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: selfPublishAuditAction,
			result: 'failure',
			details: expect.objectContaining({
				error: 'The published version changed.',
			}),
		}),
	)
})
