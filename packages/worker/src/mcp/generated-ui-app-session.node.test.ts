import { expect, test, vi } from 'vitest'
import {
	createGeneratedUiAppSession,
	defaultGeneratedUiSessionTtlMs,
	verifyGeneratedUiAppSession,
} from './generated-ui-app-session.ts'

const testEnv = {
	COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters-long!!',
}

test('default TTL is 15 minutes', () => {
	expect(defaultGeneratedUiSessionTtlMs).toBe(15 * 60 * 1000)
})

test('minted session token contains only userId and email in user payload', async () => {
	const session = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@test.com',
			displayName: 'Test User',
		},
		appId: 'app-1',
		params: { key: 'val' },
	})
	expect(session.sessionId).toBeTruthy()
	expect(session.token).toBeTruthy()

	const payload = await verifyGeneratedUiAppSession(testEnv, session.token)
	expect(payload.user).toEqual({ userId: 'user-123', email: 'user@test.com' })
	expect((payload.user as Record<string, unknown>).displayName).toBeUndefined()
})

test('session expires after the configured TTL', async () => {
	const now = Date.now()
	vi.setSystemTime(now)
	const session = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: { userId: 'u1', email: 'e@x.com', displayName: '' },
	})

	vi.setSystemTime(now + defaultGeneratedUiSessionTtlMs + 1)
	await expect(
		verifyGeneratedUiAppSession(testEnv, session.token),
	).rejects.toThrow('expired')

	vi.useRealTimers()
})

test('session is valid just before expiry', async () => {
	const now = Date.now()
	vi.setSystemTime(now)
	const session = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: { userId: 'u1', email: 'e@x.com', displayName: '' },
	})

	vi.setSystemTime(now + defaultGeneratedUiSessionTtlMs - 1000)
	const payload = await verifyGeneratedUiAppSession(testEnv, session.token)
	expect(payload.user.userId).toBe('u1')

	vi.useRealTimers()
})

test('verify rejects token when expectedSessionId does not match', async () => {
	const session = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: { userId: 'u1', email: 'e@x.com', displayName: '' },
	})
	await expect(
		verifyGeneratedUiAppSession(testEnv, session.token, 'wrong-session-id'),
	).rejects.toThrow('does not match')
})

test('verify succeeds when expectedSessionId matches', async () => {
	const session = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: { userId: 'u1', email: 'e@x.com', displayName: '' },
	})
	const payload = await verifyGeneratedUiAppSession(
		testEnv,
		session.token,
		session.sessionId,
	)
	expect(payload.session_id).toBe(session.sessionId)
})
