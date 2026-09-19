import { expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import {
	createAccountExperimentsApiHandler,
	createAccountExperimentsHandler,
} from './account-experiments.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	loadAccountExperimentsData: vi.fn(),
	setExperimentsOptIn: vi.fn(async () => undefined),
	renderAppPage: vi.fn(async () => new Response('ok')),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/account-experiments-data.ts', () => ({
	loadAccountExperimentsData: (...args: Array<unknown>) =>
		mockModule.loadAccountExperimentsData(...args),
	setExperimentsOptIn: (...args: Array<unknown>) =>
		mockModule.setExperimentsOptIn(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
}))

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

function createUser() {
	return {
		sessionUserId: '7',
		userId: 7,
		username: 'jane',
		email: 'jane@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'jane',
		roles: ['user'] as const,
		permissions: [],
		artifactOwnerIds: ['7'],
		mcpUser: {
			userId: 'a'.repeat(64),
			email: 'jane@example.com',
			username: 'jane',
			displayName: 'jane',
		},
	}
}

test('account experiments page requires auth and renders loader data', async () => {
	const env = createEnv()
	const handler = createAccountExperimentsHandler(env)
	const loginRedirect = new Response(null, {
		status: 302,
		headers: { Location: '/login' },
	})
	mockModule.requireAuthenticatedPageUser.mockResolvedValueOnce(loginRedirect)
	const denied = await handler.handler({
		request: new Request('https://kody.example/account/experiments'),
		params: {},
		url: new URL('https://kody.example/account/experiments'),
	} as never)
	expect(denied).toBe(loginRedirect)

	const user = createUser()
	mockModule.requireAuthenticatedPageUser.mockResolvedValueOnce(user)
	mockModule.loadAccountExperimentsData.mockResolvedValueOnce({
		ok: true,
		experimentsOptIn: false,
	})
	await handler.handler({
		request: new Request('https://kody.example/account/experiments'),
		params: {},
		url: new URL('https://kody.example/account/experiments'),
	} as never)
	expect(mockModule.loadAccountExperimentsData).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 7,
	})
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({
			title: 'Experiments',
			loaderData: {
				accountExperiments: { ok: true, experimentsOptIn: false },
			},
		}),
	)
})

test('account experiments API persists opt-in and opt-out with audit', async () => {
	const env = createEnv()
	const handler = createAccountExperimentsApiHandler(env)
	const url = new URL('https://kody.example/account/experiments.json')

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler({
		request: new Request(url, { method: 'GET' }),
		params: {},
		url,
	} as never)
	expect(unauthorized.status).toBe(401)

	const user = createUser()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(user)
	mockModule.loadAccountExperimentsData.mockResolvedValue({
		ok: true,
		experimentsOptIn: false,
	})
	const getResponse = await handler.handler({
		request: new Request(url, { method: 'GET' }),
		params: {},
		url,
	} as never)
	expect(getResponse.status).toBe(200)
	await expect(getResponse.json()).resolves.toEqual({
		ok: true,
		experimentsOptIn: false,
	})

	mockModule.loadAccountExperimentsData.mockResolvedValue({
		ok: true,
		experimentsOptIn: true,
	})
	const optIn = await handler.handler({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ experimentsOptIn: true }),
		}),
		params: {},
		url,
	} as never)
	expect(mockModule.setExperimentsOptIn).toHaveBeenCalledWith(env.APP_DB, {
		userId: 7,
		enabled: true,
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'experiments_opt_in',
			result: 'success',
			email: 'jane@example.com',
			reason: 'experiments_opt_in=true',
		}),
	)
	await expect(optIn.json()).resolves.toEqual({
		ok: true,
		experimentsOptIn: true,
	})

	mockModule.loadAccountExperimentsData.mockResolvedValue({
		ok: true,
		experimentsOptIn: false,
	})
	await handler.handler({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ experimentsOptIn: false }),
		}),
		params: {},
		url,
	} as never)
	expect(mockModule.setExperimentsOptIn).toHaveBeenCalledWith(env.APP_DB, {
		userId: 7,
		enabled: false,
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'experiments_opt_out',
			reason: 'experiments_opt_in=false',
		}),
	)

	const badBody = await handler.handler({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ experimentsOptIn: 'yes' }),
		}),
		params: {},
		url,
	} as never)
	expect(badBody.status).toBe(400)
})
