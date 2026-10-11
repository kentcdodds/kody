import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	writablePackage: null as ReturnType<typeof createSavedPackage> | null,
	updateSavedPackage: vi.fn(),
	publishCommunityListing: vi.fn(),
	unpublishCommunityListing: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	reloadAccountPackagesAfterWrite: vi.fn(),
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

vi.mock('#worker/package-registry/repo.ts', () => ({
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: (...args: Array<unknown>) =>
		mockModule.publishCommunityListing(...args),
	unpublishCommunityListing: (...args: Array<unknown>) =>
		mockModule.unpublishCommunityListing(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	reloadAccountPackagesAfterWrite: (...args: Array<unknown>) =>
		mockModule.reloadAccountPackagesAfterWrite(...args),
}))

const { handleAccountPackageVisibilityAction } =
	await import('./account-package-visibility.ts')

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

function createSavedPackage(isPrivate: boolean) {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('making a package public or private requires typing the slug', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })

	expect(
		await handleAccountPackageVisibilityAction({
			env,
			request,
			user,
			body: { action: 'delete' },
		}),
	).toBeNull()

	mockModule.writablePackage = createSavedPackage(true)
	const missingPublicConfirm = await handleAccountPackageVisibilityAction({
		env,
		request,
		user,
		body: {
			action: 'set-visibility',
			packageId: 'pkg-1',
			visibility: 'public',
		},
	})
	expect(missingPublicConfirm?.status).toBe(400)
	await expect(missingPublicConfirm?.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('Type the package slug "notes"'),
	})
	expect(mockModule.publishCommunityListing).not.toHaveBeenCalled()

	const publicOk = await handleAccountPackageVisibilityAction({
		env,
		request,
		user,
		body: {
			action: 'set-visibility',
			packageId: 'pkg-1',
			visibility: 'public',
			confirmName: 'notes',
		},
	})
	expect(publicOk?.status).toBe(200)
	expect(mockModule.publishCommunityListing).toHaveBeenCalled()

	mockModule.writablePackage = createSavedPackage(false)
	const missingPrivateConfirm = await handleAccountPackageVisibilityAction({
		env,
		request,
		user,
		body: {
			action: 'set-visibility',
			packageId: 'pkg-1',
			visibility: 'private',
		},
	})
	expect(missingPrivateConfirm?.status).toBe(400)
	expect(mockModule.unpublishCommunityListing).not.toHaveBeenCalled()
})
