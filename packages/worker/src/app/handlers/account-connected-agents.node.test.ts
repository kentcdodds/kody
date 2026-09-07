import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountConnectedAgentsApiHandler } from '#app/handlers/account-connected-agents.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const userOneSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('one@example.com'),
	email: 'one@example.com',
	rememberMe: false,
}

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

function createAppEnv(helpers?: {
	listUserGrants: ReturnType<typeof vi.fn>
	revokeGrant: ReturnType<typeof vi.fn>
	lookupClient?: ReturnType<typeof vi.fn>
}) {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		OAUTH_PROVIDER: helpers,
	} as unknown as Env
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(handler: Handler, request: Request) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

test('connected agents API lists unique inbound clients and revokes every grant for one clientId', async () => {
	setAuthSessionSecret(testCookieSecret)
	const grants = [
		{
			id: 'grant-1',
			clientId: 'client-a',
			scope: ['profile'],
			createdAt: 1_700_000_000,
		},
		{
			id: 'grant-2',
			clientId: 'client-a',
			scope: ['profile'],
			createdAt: 1_700_000_100,
		},
		{
			id: 'grant-3',
			clientId: 'https://chatgpt.com/oauth/vG3/client.json',
			scope: ['profile'],
			redirectUri: 'https://chatgpt.com/connector/oauth/vG3',
			createdAt: 1_700_000_200,
		},
	]
	const helpers = {
		listUserGrants: vi.fn(async () => ({
			items: grants.filter((grant) => grant.id !== 'revoked'),
		})),
		revokeGrant: vi.fn(async (grantId: string) => {
			const index = grants.findIndex((grant) => grant.id === grantId)
			if (index >= 0) grants.splice(index, 1)
		}),
		lookupClient: vi.fn(async (clientId: string) => {
			if (clientId === 'client-a') {
				return { clientId, clientName: 'Cursor' }
			}
			return { clientId, clientName: 'ChatGPT' }
		}),
	}
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: userOneSession.email,
		mcpUser: { userId: userOneSession.stableUserId },
	})
	const cookie = await createAuthCookie(userOneSession, false)
	const handler = createAccountConnectedAgentsApiHandler(createAppEnv(helpers))

	const listed = await runHandler(
		handler,
		new Request('https://example.com/account/connected-agents.json', {
			headers: { Cookie: cookie, Accept: 'application/json' },
		}),
	)
	expect(listed.status).toBe(200)
	const listBody = (await listed.json()) as {
		ok: true
		agents: Array<{ clientId: string; label: string; kind: string | null }>
	}
	expect(listBody.ok).toBe(true)
	expect(listBody.agents.map((agent) => agent.label)).toEqual([
		'ChatGPT.com',
		'Cursor',
	])

	const revoked = await runHandler(
		handler,
		new Request('https://example.com/account/connected-agents.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'revoke', clientId: 'client-a' }),
		}),
	)
	expect(revoked.status).toBe(200)
	expect(helpers.revokeGrant).toHaveBeenCalledTimes(2)
	const revokeBody = (await revoked.json()) as {
		ok: true
		agents: Array<{ clientId: string }>
	}
	expect(revokeBody.agents.map((agent) => agent.clientId)).toEqual([
		'https://chatgpt.com/oauth/vG3/client.json',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'oauth',
			action: 'mcp_inbound_grant_revoke',
			result: 'success',
			clientId: 'client-a',
		}),
	)

	const missing = await runHandler(
		handler,
		new Request('https://example.com/account/connected-agents.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'revoke', clientId: 'missing' }),
		}),
	)
	expect(missing.status).toBe(404)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await runHandler(
		handler,
		new Request('https://example.com/account/connected-agents.json'),
	)
	expect(unauthorized.status).toBe(401)
})
