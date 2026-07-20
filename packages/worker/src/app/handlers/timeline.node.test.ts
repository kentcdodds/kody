import { expect, test, vi } from 'vitest'
import { createTimelineApiHandler, createTimelineHandler } from './timeline.tsx'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	readAuthSessionResult: vi.fn(),
	redirectToLogin: vi.fn(),
	redirectToLoginWhenUnauthenticated: vi.fn(),
	getCommunityTimeline: vi.fn(),
	renderAppPage: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: (...args: Array<unknown>) =>
		mockModule.readAuthSessionResult(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: (...args: Array<unknown>) =>
		mockModule.redirectToLogin(...args),
	redirectToLoginWhenUnauthenticated: (...args: Array<unknown>) =>
		mockModule.redirectToLoginWhenUnauthenticated(...args),
}))

vi.mock('#worker/community/social-service.ts', () => ({
	getCommunityTimeline: (...args: Array<unknown>) =>
		mockModule.getCommunityTimeline(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
}))

const env = {} as Env

test('timeline page redirect, API items, and auth requirements', async () => {
	mockModule.readAuthSessionResult.mockResolvedValue({ session: null })
	mockModule.redirectToLogin.mockReturnValue(
		new Response(null, { status: 302 }),
	)

	const pageHandler = createTimelineHandler(env)
	const redirectResponse = await pageHandler.handler({
		request: new Request('https://example.com/timeline'),
		params: {},
		url: new URL('https://example.com/timeline'),
	} as never)
	expect(redirectResponse.status).toBe(302)
	expect(mockModule.redirectToLogin).toHaveBeenCalled()
	expect(mockModule.getCommunityTimeline).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const apiHandler = createTimelineApiHandler(env)
	const unauthorized = await apiHandler.handler({
		request: new Request('https://example.com/timeline.json'),
		params: {},
		url: new URL('https://example.com/timeline.json'),
	} as never)
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-viewer' },
	})
	mockModule.getCommunityTimeline.mockResolvedValue([
		{
			type: 'listing_published',
			actorUserId: 'stable-alice',
			actorUsername: 'alice',
			actorDisplayName: 'Alice',
			actorAvatarKey: null,
			listingId: 'listing-1',
			listingName: '@alice/helper',
			listingKodyId: 'helper',
			createdAt: '2026-07-01T00:00:00.000Z',
		},
	])

	const authorized = await apiHandler.handler({
		request: new Request('https://example.com/timeline.json'),
		params: {},
		url: new URL('https://example.com/timeline.json'),
	} as never)
	const body = await authorized.json()
	expect(authorized.status).toBe(200)
	expect(body.ok).toBe(true)
	expect(body.items).toHaveLength(1)
	expect(body.items[0].actorUsername).toBe('alice')
	expect(mockModule.getCommunityTimeline).toHaveBeenCalledWith({
		env,
		userId: 'stable-viewer',
		limit: 50,
	})
})
