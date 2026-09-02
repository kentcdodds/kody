import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { signupModeKvKey } from '#worker/signup-mode-setting.ts'
import { adminSignupModeGetCapability } from './admin-signup-mode-get.ts'
import { adminSignupModeSetCapability } from './admin-signup-mode-set.ts'

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

function createContext(
	roles: Array<string>,
	envOverrides: Record<string, unknown> = {},
) {
	const adminStableUserId = testStableUserIdFromEmail('admin@example.com')
	return {
		env: {
			SIGNUP_MODE: 'invite',
			APP_DB: {} as D1Database,
			...envOverrides,
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: adminStableUserId,
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
		adminStableUserId,
	}
}

test('adminSignupModeGet and adminSignupModeSet: found, missing, non-admin denied, audit row', async () => {
	const userCtx = createContext(['user'], {
		BUNDLE_ARTIFACTS_KV: createMemoryKv(),
	})
	await expect(
		adminSignupModeGetCapability.handler({}, userCtx),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminSignupModeSetCapability.handler({ mode: 'waitlist' }, userCtx),
	).rejects.toThrow('lacks required role "admin"')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	const missingKv = createMemoryKv()
	const missingCtx = createContext(['admin'], {
		BUNDLE_ARTIFACTS_KV: missingKv,
		TURNSTILE_SITE_KEY: 'site-key',
		TURNSTILE_SECRET_KEY: 'secret-key',
	})
	const missing = await adminSignupModeGetCapability.handler({}, missingCtx)
	expect(missing).toEqual({
		signupMode: {
			mode: 'invite',
			source: 'env',
			envDefault: 'invite',
			updatedAt: null,
			updatedBy: null,
		},
	})

	const foundKv = createMemoryKv({
		[signupModeKvKey]: JSON.stringify({
			mode: 'waitlist',
			updatedAt: '2026-09-01T00:00:00.000Z',
			updatedBy: missingCtx.adminStableUserId,
		}),
	})
	const foundCtx = createContext(['admin'], { BUNDLE_ARTIFACTS_KV: foundKv })
	const found = await adminSignupModeGetCapability.handler({}, foundCtx)
	expect(found.signupMode).toEqual({
		mode: 'waitlist',
		source: 'kv',
		envDefault: 'invite',
		updatedAt: '2026-09-01T00:00:00.000Z',
		updatedBy: missingCtx.adminStableUserId,
	})

	const setResult = await adminSignupModeSetCapability.handler(
		{ mode: 'waitlist' },
		missingCtx,
	)
	expect(setResult.previousMode).toBe('invite')
	expect(setResult.signupMode.mode).toBe('waitlist')
	expect(setResult.signupMode.source).toBe('kv')
	expect(setResult.signupMode.updatedBy).toBe(missingCtx.adminStableUserId)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'signup_mode_set',
			result: 'success',
			reason: 'old=invite;new=waitlist',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminSignupModeSet',
			result: 'success',
			reason: 'old=invite;new=waitlist',
		}),
	)

	await expect(
		adminSignupModeSetCapability.handler(
			{ mode: 'open' },
			createContext(['admin'], { BUNDLE_ARTIFACTS_KV: createMemoryKv() }),
		),
	).rejects.toThrow('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY')

	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'mcp_capability_denied:failure',
		'adminSignupModeGet:success',
		'adminSignupModeGet:success',
		'signup_mode_set:success',
		'adminSignupModeSet:success',
		'adminSignupModeSet:failure',
	])
})
