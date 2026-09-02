import { expect, test, vi } from 'vitest'
import { type AdminInvitesLoaderData } from '#universal/loader-data.ts'
import { signupModeKvKey } from '#worker/signup-mode-setting.ts'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	loadAdminInvitesData: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#app/admin-invites-data.ts', () => ({
	loadAdminInvitesData: (...args: Array<unknown>) =>
		mockModule.loadAdminInvitesData(...args),
}))

const { createAdminInvitesApiHandler } = await import('./admin-invites.ts')

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
		store,
	} as unknown as KVNamespace & { store: Map<string, string> }
}

function loaderPayload(
	mode: 'invite' | 'open' | 'waitlist',
): AdminInvitesLoaderData {
	return {
		ok: true,
		invites: [],
		availablePlans: ['free'],
		signupMode: {
			mode,
			source: mode === 'invite' ? 'env' : 'kv',
			envDefault: 'invite',
			updatedAt: mode === 'invite' ? null : '2026-09-02T00:00:00.000Z',
			updatedBy: mode === 'invite' ? null : 'admin-stable-id',
		},
	}
}

function postRequest(body: Record<string, unknown>) {
	return new Request('https://example.com/admin/invites.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

test('set_signup_mode writes when expectedCurrentMode matches and returns 409 when it does not', async () => {
	mockModule.requireUserWithRole.mockResolvedValue({
		email: 'admin@example.com',
		mcpUser: { userId: 'admin-stable-id' },
	})
	mockModule.loadAdminInvitesData.mockResolvedValue(loaderPayload('waitlist'))

	const kv = createMemoryKv()
	const putSpy = vi.spyOn(kv, 'put')
	const env = {
		SIGNUP_MODE: 'invite',
		BUNDLE_ARTIFACTS_KV: kv,
		TURNSTILE_SITE_KEY: 'site-key',
		TURNSTILE_SECRET_KEY: 'secret-key',
		APP_DB: {} as D1Database,
	} as unknown as Env
	const handler = createAdminInvitesApiHandler(env)
	const url = new URL('https://example.com/admin/invites.json')

	const omitted = await handler.handler({
		request: postRequest({ action: 'set_signup_mode', mode: 'waitlist' }),
		params: {},
		url,
	} as never)
	expect(omitted.status).toBe(400)
	expect(await omitted.json()).toEqual({
		ok: false,
		error: 'expectedCurrentMode must be invite, open, or waitlist.',
	})
	expect(putSpy).not.toHaveBeenCalled()

	const matched = await handler.handler({
		request: postRequest({
			action: 'set_signup_mode',
			mode: 'waitlist',
			expectedCurrentMode: 'invite',
		}),
		params: {},
		url,
	} as never)
	expect(matched.status).toBe(200)
	expect(putSpy).toHaveBeenCalledTimes(1)
	expect(JSON.parse(kv.store.get(signupModeKvKey) ?? '{}').mode).toBe(
		'waitlist',
	)

	putSpy.mockClear()
	const stored = kv.store.get(signupModeKvKey)
	const mismatched = await handler.handler({
		request: postRequest({
			action: 'set_signup_mode',
			mode: 'open',
			expectedCurrentMode: 'invite',
		}),
		params: {},
		url,
	} as never)
	expect(mismatched.status).toBe(409)
	expect(await mismatched.json()).toMatchObject({
		ok: false,
		signupMode: { mode: 'waitlist', source: 'kv' },
	})
	expect(putSpy).not.toHaveBeenCalled()
	expect(kv.store.get(signupModeKvKey)).toBe(stored)
})
