import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { createCommunityInstallApiPostHandler } from './community-install.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityListingById: vi.fn(),
	installCommunityListing: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/community/install.ts', () => ({
	installCommunityListing: (...args: Array<unknown>) =>
		mockModule.installCommunityListing(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

const env = { APP_DB: {} as D1Database } as Env

function buildInstallRequest(body: unknown) {
	return {
		request: new Request(
			'https://example.com/community/listing-1/install.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/install.json'),
	} as never
}

function authenticatedUser() {
	return {
		email: 'userb@example.com',
		mcpUser: { userId: 'stable-user-b', email: 'userb@example.com' },
	}
}

test('community install POST enforces auth, listing state, and the untrusted acknowledgement gate', async () => {
	const handler = createCommunityInstallApiPostHandler(env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler(buildInstallRequest({}))
	expect(unauthorized.status).toBe(401)
	expect(mockModule.installCommunityListing).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(authenticatedUser())
	mockModule.getCommunityListingById.mockResolvedValue(null)
	const notFound = await handler.handler(buildInstallRequest({}))
	expect(notFound.status).toBe(404)

	mockModule.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		trusted: false,
		pinnedCommit: 'commit-1',
	})
	const unacknowledged = await handler.handler(buildInstallRequest({}))
	expect(unacknowledged.status).toBe(409)
	expect(await unacknowledged.json()).toMatchObject({
		ok: false,
		requiresAcknowledgement: true,
	})
	expect(mockModule.installCommunityListing).not.toHaveBeenCalled()

	const invalidBody = await handler.handler(
		buildInstallRequest({ acknowledged_untrusted: 'yes' }),
	)
	expect(invalidBody.status).toBe(400)
	expect(mockModule.installCommunityListing).not.toHaveBeenCalled()
})

test('community install POST installs and maps service outcomes and errors', async () => {
	const handler = createCommunityInstallApiPostHandler(env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(authenticatedUser())
	mockModule.getMcpUserPackageScope.mockResolvedValue('userb')

	// Untrusted listings install once the caller acknowledged the warning.
	mockModule.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		trusted: false,
		pinnedCommit: 'commit-1',
	})
	mockModule.installCommunityListing.mockResolvedValue({
		status: 'installed',
		forkId: 'fork-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		originCommit: 'commit-1',
	})
	const installed = await handler.handler(
		buildInstallRequest({ acknowledged_untrusted: true }),
	)
	expect(installed.status).toBe(200)
	const installedPayload = (await installed.json()) as Record<string, unknown>
	expect(installedPayload).toMatchObject({
		ok: true,
		status: 'installed',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetName: '@userb/demo',
	})
	expect(installedPayload.agentPrompt).toContain('@userb/demo')
	expect(mockModule.installCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			userId: 'stable-user-b',
			userEmail: 'userb@example.com',
			expectedPackageScope: 'userb',
			listingId: 'listing-1',
			// The acknowledgement is bound to the commit the listing pinned
			// when the handler checked trust.
			expectedPinnedCommit: 'commit-1',
		}),
	)

	// Trusted listings install without an acknowledgement.
	mockModule.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		trusted: true,
		pinnedCommit: 'commit-1',
	})
	mockModule.installCommunityListing.mockResolvedValue({
		status: 'adaptation_required',
		forkId: 'fork-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		originCommit: 'commit-1',
		failedChecks: [{ kind: 'bundle', ok: false, message: 'unresolved' }],
		crossScopeReferences: [{ file: 'src/index.ts', specifier: 'kody:@usera/' }],
	})
	const adaptation = await handler.handler(buildInstallRequest({}))
	expect(adaptation.status).toBe(200)
	const adaptationPayload = (await adaptation.json()) as Record<string, unknown>
	expect(adaptationPayload).toMatchObject({
		ok: true,
		status: 'adaptation_required',
		sourceId: 'source-1',
		failedChecks: [{ kind: 'bundle', message: 'unresolved' }],
	})
	expect(adaptationPayload.agentPrompt).toContain('source-1')

	mockModule.installCommunityListing.mockRejectedValue(
		new CommunityActionError(
			'You already have a saved package with kody id "demo". Pass a different kody_id to fork this listing.',
		),
	)
	const userFacingError = await handler.handler(buildInstallRequest({}))
	expect(userFacingError.status).toBe(400)
	expect(await userFacingError.json()).toMatchObject({
		ok: false,
		error: expect.stringContaining('already have a saved package'),
	})

	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.installCommunityListing.mockRejectedValue(
		new Error('artifacts unavailable'),
	)
	const serverError = await handler.handler(buildInstallRequest({}))
	expect(serverError.status).toBe(500)
	expect(await serverError.json()).toEqual({
		ok: false,
		error: 'Unable to install this community package.',
	})
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
