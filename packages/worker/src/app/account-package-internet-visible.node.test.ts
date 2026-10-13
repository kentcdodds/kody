import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	writablePackage: null as ReturnType<typeof createSavedPackage> | null,
	loadCapabilityApprovalSummary: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	clearInternetVisible: vi.fn(),
	reloadAccountPackagesAfterWrite: vi.fn(),
	loadOrgBindingForOrg: vi.fn(),
	approveCredentialNeedsRequest: vi.fn(),
	approveWentPublicRequest: vi.fn(),
}))

vi.mock('#app/account-package-approval-requests.ts', () => ({
	approveCredentialNeedsRequest: (...args: Array<unknown>) =>
		mockModule.approveCredentialNeedsRequest(...args),
	approveWentPublicRequest: (...args: Array<unknown>) =>
		mockModule.approveWentPublicRequest(...args),
	loadPendingPackageApprovals: async () => [],
}))

vi.mock('#app/account-package-write-access.ts', () => ({
	loadWritableAccountSavedPackage: vi.fn(
		async (input: {
			packageId: string
			user: { mcpUser: { userId: string } }
		}) => {
			if (!mockModule.writablePackage) {
				return {
					ok: false as const,
					response: new Response(
						JSON.stringify({ ok: false, error: 'Package not found.' }),
						{ status: 404 },
					),
				}
			}
			return {
				ok: true as const,
				package: {
					savedPackage: mockModule.writablePackage,
					ownerUserId: mockModule.writablePackage.userId,
					actorUserId: input.user.mcpUser.userId,
				},
			}
		},
	),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
	clearInternetVisible: (...args: Array<unknown>) =>
		mockModule.clearInternetVisible(...args),
	CapabilityApprovalError: class CapabilityApprovalError extends Error {
		constructor(message: string) {
			super(message)
			this.name = 'CapabilityApprovalError'
		}
	},
}))

vi.mock('#app/account-packages-data.ts', () => ({
	reloadAccountPackagesAfterWrite: (...args: Array<unknown>) =>
		mockModule.reloadAccountPackagesAfterWrite(...args),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: (...args: Array<unknown>) =>
		mockModule.loadOrgBindingForOrg(...args),
}))

const { handleAccountPackageInternetVisibleAction } =
	await import('./account-package-capability-approval.ts')

beforeEach(() => {
	mockModule.writablePackage = null
	mockModule.loadCapabilityApprovalSummary.mockReset()
	mockModule.approvePackageCapabilitySet.mockReset()
	mockModule.clearInternetVisible.mockReset()
	mockModule.reloadAccountPackagesAfterWrite.mockReset()
	mockModule.loadOrgBindingForOrg.mockReset()
	mockModule.approveCredentialNeedsRequest.mockReset()
	mockModule.approveWentPublicRequest.mockReset()
})

function createUser(): AuthenticatedAppUser {
	return {
		sessionUserId: '42',
		userId: 42,
		username: 'user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: [],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'user',
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	}
}

function createSavedPackage(isInternetVisible: boolean) {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('turning on internet-visible without approval returns approvalUrl', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'abc' },
		dependencySnapshot: null,
		publishedCommit: 'deadbeef',
		latestApproval: null,
		matchingApproval: null,
		fingerprintMatchesApproval: false,
		isInternetVisible: false,
	})

	const response = await handleAccountPackageInternetVisibleAction({
		env,
		request,
		user,
		body: {
			action: 'set-internet-visible',
			packageId: 'pkg-1',
			internetVisible: true,
			confirmName: 'notes',
		},
	})
	expect(response?.status).toBe(400)
	await expect(response?.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('approve'),
		approvalUrl: expect.stringContaining('/approve-capabilities'),
	})
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
})

test('turning on internet-visible with matching approval refreshes pin and enqueues went_public', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'abc' },
		dependencySnapshot: {
			version: 1,
			root: {
				packageId: 'pkg-1',
				kodyId: 'notes',
				sourceId: 'source-1',
				publishedCommit: 'deadbeef',
			},
			dependencies: [],
		},
		publishedCommit: 'deadbeef',
		latestApproval: { fingerprint: 'other' },
		matchingApproval: {
			fingerprint: 'abc',
			approvedAt: '2026-01-02T00:00:00.000Z',
		},
		fingerprintMatchesApproval: true,
		isInternetVisible: false,
	})
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-1' },
		capabilitySet: { entries: [], fingerprint: 'abc' },
		wentPublicRequest: { id: 'req-1' },
	})

	const response = await handleAccountPackageInternetVisibleAction({
		env,
		request,
		user,
		body: {
			action: 'set-internet-visible',
			packageId: 'pkg-1',
			internetVisible: true,
			confirmName: 'notes',
		},
	})
	expect(response?.status).toBe(400)
	await expect(response?.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('internet-visible'),
		approvalUrl: expect.stringContaining('/approve-capabilities'),
	})
	expect(mockModule.approvePackageCapabilitySet).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedFingerprint: 'abc',
		}),
	)
})

test('approve-capabilities binds the reviewed fingerprint', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-1' },
		capabilitySet: { entries: [], fingerprint: 'reviewed-fp' },
		wentPublicRequest: { id: 'req-1' },
	})
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })

	const response = await handleAccountPackageInternetVisibleAction({
		env,
		request,
		user,
		body: {
			action: 'approve-capabilities',
			packageId: 'pkg-1',
			fingerprint: 'reviewed-fp',
		},
	})
	expect(response?.status).toBe(200)
	expect(mockModule.approvePackageCapabilitySet).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedFingerprint: 'reviewed-fp',
		}),
	)
})

test('turning off internet-visible requires the slug and clears the flag', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(true)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.clearInternetVisible.mockResolvedValue(true)
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })

	const missing = await handleAccountPackageInternetVisibleAction({
		env,
		request,
		user,
		body: {
			action: 'set-internet-visible',
			packageId: 'pkg-1',
			internetVisible: false,
		},
	})
	expect(missing?.status).toBe(400)
	expect(mockModule.clearInternetVisible).not.toHaveBeenCalled()

	const ok = await handleAccountPackageInternetVisibleAction({
		env,
		request,
		user,
		body: {
			action: 'set-internet-visible',
			packageId: 'pkg-1',
			internetVisible: false,
			confirmName: 'notes',
		},
	})
	expect(ok?.status).toBe(200)
	expect(mockModule.clearInternetVisible).toHaveBeenCalled()
})

test('approve-credential-needs approves the named request as the acting person', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })
	const approve = (body: Record<string, unknown>) =>
		handleAccountPackageInternetVisibleAction({
			env,
			request,
			user,
			body: { action: 'approve-credential-needs', packageId: 'pkg-1', ...body },
		})

	expect((await approve({}))?.status).toBe(400)
	expect(mockModule.approveCredentialNeedsRequest).not.toHaveBeenCalled()

	mockModule.approveCredentialNeedsRequest.mockResolvedValueOnce({
		ok: false,
		status: 409,
		error: 'stale',
	})
	const stale = await approve({ requestId: 'request-1' })
	expect(stale?.status).toBe(409)
	await expect(stale?.json()).resolves.toMatchObject({
		ok: false,
		error: 'stale',
		approvalUrl: expect.stringContaining('/approve-capabilities'),
	})

	mockModule.approveCredentialNeedsRequest.mockResolvedValueOnce({ ok: true })
	expect((await approve({ requestId: 'request-1' }))?.status).toBe(200)
	expect(mockModule.approveCredentialNeedsRequest).toHaveBeenLastCalledWith(
		expect.objectContaining({
			requestId: 'request-1',
			ownerUserId: ownerIdFromStored('stable-user-1'),
			actorUserId: personIdFromStored('stable-user-1'),
		}),
	)
})

test('approve-went-public approves the named request as the acting person', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })
	const approve = (body: Record<string, unknown>) =>
		handleAccountPackageInternetVisibleAction({
			env,
			request,
			user,
			body: { action: 'approve-went-public', packageId: 'pkg-1', ...body },
		})

	expect((await approve({}))?.status).toBe(400)
	expect(mockModule.approveWentPublicRequest).not.toHaveBeenCalled()

	mockModule.approveWentPublicRequest.mockResolvedValueOnce({
		ok: false,
		status: 409,
		error: 'stale',
	})
	const stale = await approve({ requestId: 'request-went-public' })
	expect(stale?.status).toBe(409)
	await expect(stale?.json()).resolves.toMatchObject({
		ok: false,
		error: 'stale',
		approvalUrl: expect.stringContaining('/approve-capabilities'),
	})

	mockModule.approveWentPublicRequest.mockResolvedValueOnce({ ok: true })
	expect((await approve({ requestId: 'request-went-public' }))?.status).toBe(
		200,
	)
	expect(mockModule.approveWentPublicRequest).toHaveBeenLastCalledWith(
		expect.objectContaining({
			requestId: 'request-went-public',
			ownerUserId: ownerIdFromStored('stable-user-1'),
			actorUserId: personIdFromStored('stable-user-1'),
		}),
	)
})
