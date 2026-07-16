import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { createCommunityTrustApiPostHandler } from './community-trust.ts'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	setCommunityListingTrusted: vi.fn(),
	logAuditEvent: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	setCommunityListingTrusted: (...args: Array<unknown>) =>
		mockModule.setCommunityListingTrusted(...args),
}))

vi.mock('#app/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#app/audit-log.ts')>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const env = { APP_DB: {} as D1Database } as Env

function buildTrustRequest(body: unknown) {
	return {
		request: new Request('https://example.com/community/listing-1/trust.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/trust.json'),
	} as never
}

test('community trust POST enforces admin role, validation, and error mapping', async () => {
	const handler = createCommunityTrustApiPostHandler(env)

	mockModule.requireUserWithRole.mockRejectedValue(
		new Response('Forbidden', { status: 403 }),
	)
	const forbidden = await handler.handler(buildTrustRequest({ trusted: true }))
	expect(forbidden.status).toBe(403)
	expect(mockModule.setCommunityListingTrusted).not.toHaveBeenCalled()

	mockModule.requireUserWithRole.mockResolvedValue({
		email: 'admin@example.com',
		mcpUser: { userId: 'stable-admin-id' },
	})

	const invalidBody = await handler.handler(
		buildTrustRequest({ trusted: 'yes' }),
	)
	expect(invalidBody.status).toBe(400)
	expect(mockModule.setCommunityListingTrusted).not.toHaveBeenCalled()

	mockModule.setCommunityListingTrusted.mockResolvedValue({
		id: 'listing-1',
		trusted: true,
	})
	const success = await handler.handler(buildTrustRequest({ trusted: true }))
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual({ ok: true, trusted: true })
	expect(mockModule.setCommunityListingTrusted).toHaveBeenCalledWith({
		env,
		adminUserId: 'stable-admin-id',
		listingId: 'listing-1',
		trusted: true,
	})
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'community_listing_trust',
			result: 'success',
			reason: 'listing_id=listing-1;trusted=true',
		}),
	)

	mockModule.setCommunityListingTrusted.mockRejectedValue(
		new CommunityActionError(
			'Delisted community listings cannot be marked trusted.',
		),
	)
	const userFacingError = await handler.handler(
		buildTrustRequest({ trusted: true }),
	)
	expect(userFacingError.status).toBe(400)
	expect(await userFacingError.json()).toEqual({
		ok: false,
		error: 'Delisted community listings cannot be marked trusted.',
	})

	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.setCommunityListingTrusted.mockRejectedValue(
		new Error('db timeout'),
	)
	const serverError = await handler.handler(
		buildTrustRequest({ trusted: false }),
	)
	expect(serverError.status).toBe(500)
	expect(await serverError.json()).toEqual({
		ok: false,
		error: 'Unable to update trust for this listing.',
	})
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
