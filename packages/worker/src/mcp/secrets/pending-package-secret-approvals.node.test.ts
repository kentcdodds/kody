import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	findMissingPackageApprovals: vi.fn(),
}))

vi.mock('./package-access.ts', () => ({
	findMissingPackageApprovals: (...args: Array<unknown>) =>
		mockModule.findMissingPackageApprovals(...args),
}))

const { buildPendingPackageSecretApprovalsSummary } =
	await import('./pending-package-secret-approvals.ts')

test('empty approval URLs do not throw when building a pending summary', async () => {
	mockModule.findMissingPackageApprovals.mockResolvedValueOnce([
		{
			secretName: 'token',
			packageId: 'pkg-1',
			kodyId: 'notes',
			approvalUrl: '',
		},
	])
	await expect(
		buildPendingPackageSecretApprovalsSummary({
			env: { APP_DB: {} } as Env,
			baseUrl: 'https://example.com',
			userId: ownerIdFromStored('org-acme'),
			packageId: 'pkg-1',
			kodyId: 'notes',
			secretMounts: { token: { name: 'token', scope: 'user' } },
		}),
	).resolves.toEqual({
		package_id: 'pkg-1',
		kody_id: 'notes',
		slug: 'notes',
		secrets: [{ secret_name: 'token', approval_url: '' }],
		bulk_approval_url: null,
	})
})
