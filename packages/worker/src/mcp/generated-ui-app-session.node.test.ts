import { expect, test, vi } from 'vitest'
import {
	createGeneratedUiAppSession,
	defaultGeneratedUiSessionTtlMs,
	verifyGeneratedUiAppSession,
} from './generated-ui-app-session.ts'

const testEnv = {
	COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters-long!!',
}

test('generated UI app sessions mint minimal user payloads and honor TTL boundaries', async () => {
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

	const now = Date.now()
	vi.setSystemTime(now)
	const ttlSession = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: { userId: 'u1', email: 'e@x.com', displayName: '' },
	})

	vi.setSystemTime(now + defaultGeneratedUiSessionTtlMs - 1000)
	await expect(
		verifyGeneratedUiAppSession(testEnv, ttlSession.token),
	).resolves.toMatchObject({
		user: { userId: 'u1', email: 'e@x.com' },
	})

	vi.setSystemTime(now + defaultGeneratedUiSessionTtlMs + 1)
	await expect(
		verifyGeneratedUiAppSession(testEnv, ttlSession.token),
	).rejects.toThrow('expired')

	vi.useRealTimers()
})

test('verifyGeneratedUiAppSession enforces expected session ids', async () => {
	const session = await createGeneratedUiAppSession({
		env: testEnv,
		baseUrl: 'https://example.com',
		user: { userId: 'u1', email: 'e@x.com', displayName: '' },
	})

	await expect(
		verifyGeneratedUiAppSession(testEnv, session.token, 'wrong-session-id'),
	).rejects.toThrow('does not match')

	const payload = await verifyGeneratedUiAppSession(
		testEnv,
		session.token,
		session.sessionId,
	)
	expect(payload.session_id).toBe(session.sessionId)
})
