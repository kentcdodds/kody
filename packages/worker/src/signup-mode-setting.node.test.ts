import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import {
	areTurnstileKeysConfigured,
	clearSignupModeSettingCacheForTests,
	loadSignupModeSetting,
	resolveSignupMode,
	setSignupModeSetting,
	SignupModeOpenWithoutTurnstileError,
	signupModeKvKey,
	signupModeKvReadFailedLogKey,
} from './signup-mode-setting.ts'

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

function createEnv(input?: {
	signupMode?: 'invite' | 'open' | 'waitlist'
	kv?: KVNamespace
	turnstile?: boolean
}) {
	return {
		SIGNUP_MODE: input?.signupMode ?? 'invite',
		BUNDLE_ARTIFACTS_KV: input?.kv,
		TURNSTILE_SITE_KEY: input?.turnstile ? 'site-key' : undefined,
		TURNSTILE_SECRET_KEY: input?.turnstile ? 'secret-key' : undefined,
		APP_DB: {} as D1Database,
	} as unknown as Env
}

test('signup mode setting: KV override, fallbacks, memo, setter, and Turnstile guard', async () => {
	expect(await resolveSignupMode(createEnv({ signupMode: 'invite' }))).toBe(
		'invite',
	)
	expect(
		await loadSignupModeSetting(createEnv({ signupMode: 'invite' })),
	).toEqual({
		mode: 'invite',
		source: 'env',
		envDefault: 'invite',
		updatedAt: null,
		updatedBy: null,
	})

	const overrideKv = createMemoryKv({
		[signupModeKvKey]: JSON.stringify({
			mode: 'open',
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	const envWithOverride = createEnv({ signupMode: 'invite', kv: overrideKv })
	expect(await resolveSignupMode(envWithOverride)).toBe('open')
	expect(await loadSignupModeSetting(envWithOverride)).toEqual({
		mode: 'open',
		source: 'kv',
		envDefault: 'invite',
		updatedAt: '2026-09-02T00:00:00.000Z',
		updatedBy: 'admin-stable-id',
	})

	clearSignupModeSettingCacheForTests()
	consoleWarn.mockImplementation(() => {})
	expect(
		await resolveSignupMode(
			createEnv({
				signupMode: 'waitlist',
				kv: createMemoryKv({ [signupModeKvKey]: '{not-json' }),
			}),
		),
	).toBe('waitlist')
	expect(consoleWarn).toHaveBeenCalledWith(
		signupModeKvReadFailedLogKey,
		expect.anything(),
	)

	clearSignupModeSettingCacheForTests()
	expect(
		await resolveSignupMode(
			createEnv({
				signupMode: 'invite',
				kv: createMemoryKv({
					[signupModeKvKey]: JSON.stringify({
						mode: 'nope',
						updatedAt: 'x',
					}),
				}),
			}),
		),
	).toBe('invite')

	expect(
		await resolveSignupMode(
			createEnv({ signupMode: 'open', kv: createMemoryKv() }),
		),
	).toBe('open')

	clearSignupModeSettingCacheForTests()
	vi.useFakeTimers()
	const memoKv = createMemoryKv({
		[signupModeKvKey]: JSON.stringify({
			mode: 'waitlist',
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	const getSpy = vi.spyOn(memoKv, 'get')
	const memoEnv = createEnv({ signupMode: 'invite', kv: memoKv })
	expect(await resolveSignupMode(memoEnv)).toBe('waitlist')
	expect(await resolveSignupMode(memoEnv)).toBe('waitlist')
	expect(getSpy).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(30_000)
	expect(await resolveSignupMode(memoEnv)).toBe('waitlist')
	expect(getSpy).toHaveBeenCalledTimes(2)
	vi.useRealTimers()

	clearSignupModeSettingCacheForTests()
	const setKv = createMemoryKv()
	const setGetSpy = vi.spyOn(setKv, 'get')
	const setEnv = createEnv({ signupMode: 'invite', kv: setKv, turnstile: true })
	expect(await resolveSignupMode(setEnv)).toBe('invite')
	expect(setGetSpy).toHaveBeenCalledTimes(1)
	const changed = await setSignupModeSetting({
		env: setEnv,
		mode: 'open',
		updatedBy: 'admin-stable-id',
		actorEmail: 'admin@example.com',
		path: '/admin/invites.json',
	})
	expect(changed.previous.mode).toBe('invite')
	expect(changed.current).toMatchObject({
		mode: 'open',
		source: 'kv',
		updatedBy: 'admin-stable-id',
	})
	const getsAfterSet = setGetSpy.mock.calls.length
	expect(await resolveSignupMode(setEnv)).toBe('open')
	expect(setGetSpy.mock.calls.length).toBe(getsAfterSet + 1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'signup_mode_set',
			result: 'success',
			reason: 'old=invite;new=open',
		}),
	)
	expect(auditEventSummaries()).toEqual(['signup_mode_set:success'])

	const noTurnstileEnv = createEnv({
		signupMode: 'invite',
		kv: createMemoryKv(),
	})
	expect(areTurnstileKeysConfigured(noTurnstileEnv)).toBe(false)
	await expect(
		setSignupModeSetting({
			env: noTurnstileEnv,
			mode: 'open',
			updatedBy: 'admin-stable-id',
		}),
	).rejects.toThrow(SignupModeOpenWithoutTurnstileError)
})
