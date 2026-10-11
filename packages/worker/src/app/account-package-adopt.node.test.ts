import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	adoptCommunityFork: vi.fn(),
	loadAccountPackagesData: vi.fn(),
	getSavedPackageById: vi.fn(),
	authorizePackageWrite: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	adoptCommunityFork: (...args: Array<unknown>) =>
		mockModule.adoptCommunityFork(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackagesData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackagesData(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		authorizePackageWrite: (...args: Array<unknown>) =>
			mockModule.authorizePackageWrite(...args),
	}
})

const { handleAccountPackageAdoptAction } =
	await import('./account-package-adopt.ts')

function createUser() {
	const actor = personIdFromStored('stable-user-1')
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
			userId: actor,
			email: 'user@example.com',
			username: 'user',
			displayName: 'user',
		},
		request: sessionRequestContext(actor),
	}
}

function mockSavedPackage() {
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/pkg',
		kodyId: 'pkg',
	})
	mockModule.authorizePackageWrite.mockResolvedValue(undefined)
}

test('the signed-in owner adopts a community fork from the account API', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockSavedPackage()
	mockModule.adoptCommunityFork.mockResolvedValue({ alreadyAdopted: false })
	mockModule.loadAccountPackagesData.mockResolvedValue({
		ok: true,
		selectedPackage: { id: 'pkg-1' },
	})

	expect(
		await handleAccountPackageAdoptAction({
			env,
			request,
			user,
			body: { action: 'set-visibility' },
		}),
	).toBeNull()

	const response = await handleAccountPackageAdoptAction({
		env,
		request,
		user,
		body: {
			action: 'adopt-community-fork',
			packageId: 'pkg-1',
			reviewNote: '  Read src/ and package.json; no exfiltration.  ',
		},
	})
	expect(response?.status).toBe(200)
	await expect(response?.json()).resolves.toEqual({
		ok: true,
		selectedPackage: { id: 'pkg-1' },
	})
	expect(mockModule.authorizePackageWrite).toHaveBeenCalled()
	expect(mockModule.adoptCommunityFork).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('stable-user-1'),
		packageId: 'pkg-1',
		reviewSummary: 'Read src/ and package.json; no exfiltration.',
	})
	expect(mockModule.loadAccountPackagesData).toHaveBeenCalledWith({
		env,
		request,
		user,
		pathPackageId: 'pkg-1',
	})
})

test('account adopt requires a package id and surfaces caller-clearable errors', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})

	const missingId = await handleAccountPackageAdoptAction({
		env,
		request,
		user,
		body: { action: 'adopt-community-fork', reviewNote: 'Reviewed it all.' },
	})
	expect(missingId?.status).toBe(400)
	expect(mockModule.adoptCommunityFork).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	const missingPackage = await handleAccountPackageAdoptAction({
		env,
		request,
		user,
		body: {
			action: 'adopt-community-fork',
			packageId: 'pkg-missing',
			reviewNote: 'Reviewed it all carefully.',
		},
	})
	expect(missingPackage?.status).toBe(404)
	expect(mockModule.adoptCommunityFork).not.toHaveBeenCalled()

	mockSavedPackage()
	mockModule.adoptCommunityFork.mockRejectedValueOnce(
		new CommunityActionError('Adoption requires a review note of at least 10'),
	)
	const shortNote = await handleAccountPackageAdoptAction({
		env,
		request,
		user,
		body: {
			action: 'adopt-community-fork',
			packageId: 'pkg-1',
			reviewNote: 'short',
		},
	})
	expect(shortNote?.status).toBe(400)
	await expect(shortNote?.json()).resolves.toEqual({
		ok: false,
		error: 'Adoption requires a review note of at least 10',
	})
	expect(mockModule.loadAccountPackagesData).not.toHaveBeenCalled()
})
