import {
	getSignupMode,
	isSignupMode,
	type SignupMode,
	type SignupModeSetting,
} from '#universal/signup-mode.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'

export const signupModeKvKey = 'platform-settings:v1:signup-mode'
const signupModeCacheTtlMs = 30_000
export const signupModeKvReadFailedLogKey = 'signup-mode-kv-read-failed'

type SignupModeRecord = {
	mode: SignupMode
	updatedAt: string
	updatedBy: string
}

type SignupModeEnv = Pick<
	Env,
	| 'SIGNUP_MODE'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'TURNSTILE_SITE_KEY'
	| 'TURNSTILE_SECRET_KEY'
	| 'APP_DB'
	| 'AUDIT_DB'
	| 'SENTRY_ENVIRONMENT'
>

let cacheGeneration = 0
const memos = new WeakMap<
	object,
	{ expiresAt: number; pending: Promise<SignupMode>; generation: number }
>()

export function clearSignupModeSettingCacheForTests() {
	cacheGeneration += 1
}

function parseSignupModeRecord(value: unknown): SignupModeRecord | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	if (!isSignupMode(record.mode)) return null
	if (typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) {
		return null
	}
	if (typeof record.updatedBy !== 'string' || record.updatedBy.length === 0) {
		return null
	}
	return {
		mode: record.mode,
		updatedAt: record.updatedAt,
		updatedBy: record.updatedBy,
	}
}

function envDefault(env: Pick<Env, 'SIGNUP_MODE'>): SignupMode {
	return getSignupMode(env)
}

function envFallbackSetting(env: Pick<Env, 'SIGNUP_MODE'>): SignupModeSetting {
	const mode = envDefault(env)
	return {
		mode,
		source: 'env',
		envDefault: mode,
		updatedAt: null,
		updatedBy: null,
	}
}

export function areTurnstileKeysConfigured(
	env: Pick<Env, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>,
) {
	return Boolean(
		env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim(),
	)
}

export class SignupModeOpenWithoutTurnstileError extends Error {
	constructor() {
		super(
			'Cannot set signup mode to open until TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are both configured.',
		)
		this.name = 'SignupModeOpenWithoutTurnstileError'
	}
}

export class SignupModeStaleWriteError extends Error {
	readonly current: SignupModeSetting
	constructor(current: SignupModeSetting) {
		super(
			`Signup mode changed. Current mode is ${current.mode}. Retry with expectedCurrentMode=${current.mode}.`,
		)
		this.name = 'SignupModeStaleWriteError'
		this.current = current
	}
}

async function loadSignupModeSettingUncached(
	env: SignupModeEnv,
): Promise<SignupModeSetting> {
	const fallback = envFallbackSetting(env)
	const kv = env.BUNDLE_ARTIFACTS_KV
	if (!kv) return fallback
	try {
		const parsed = parseSignupModeRecord(await kv.get(signupModeKvKey, 'json'))
		if (!parsed) return fallback
		return {
			mode: parsed.mode,
			source: 'kv',
			envDefault: fallback.envDefault,
			updatedAt: parsed.updatedAt,
			updatedBy: parsed.updatedBy,
		}
	} catch (error) {
		console.warn(signupModeKvReadFailedLogKey, error)
		return fallback
	}
}

export async function loadSignupModeSetting(
	env: SignupModeEnv,
): Promise<SignupModeSetting> {
	return loadSignupModeSettingUncached(env)
}

export async function resolveSignupMode(
	env: SignupModeEnv,
): Promise<SignupMode> {
	const now = Date.now()
	const cached = memos.get(env)
	if (
		cached &&
		cached.generation === cacheGeneration &&
		cached.expiresAt > now
	) {
		return cached.pending
	}
	const pending = loadSignupModeSettingUncached(env).then(
		(setting) => setting.mode,
	)
	memos.set(env, {
		expiresAt: now + signupModeCacheTtlMs,
		pending,
		generation: cacheGeneration,
	})
	pending.catch(() => {
		if (memos.get(env)?.pending === pending) memos.delete(env)
	})
	return pending
}

export async function setSignupModeSetting(input: {
	env: SignupModeEnv
	mode: SignupMode
	expectedCurrentMode: SignupMode
	updatedBy: string
	actorEmail?: string
	path?: string
	ip?: string
}): Promise<{ previous: SignupModeSetting; current: SignupModeSetting }> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error('BUNDLE_ARTIFACTS_KV is required to persist signup mode.')
	}
	const previous = await loadSignupModeSettingUncached(input.env)
	if (previous.mode !== input.expectedCurrentMode) {
		throw new SignupModeStaleWriteError(previous)
	}
	if (input.mode === 'open' && !areTurnstileKeysConfigured(input.env)) {
		throw new SignupModeOpenWithoutTurnstileError()
	}
	const updatedAt = new Date().toISOString()
	const record: SignupModeRecord = {
		mode: input.mode,
		updatedAt,
		updatedBy: input.updatedBy,
	}
	await kv.put(signupModeKvKey, JSON.stringify(record))
	memos.delete(input.env)
	const current: SignupModeSetting = {
		mode: input.mode,
		source: 'kv',
		envDefault: previous.envDefault,
		updatedAt,
		updatedBy: input.updatedBy,
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'signup_mode_set',
		result: 'success',
		email: input.actorEmail,
		ip: input.ip,
		path: input.path,
		reason: `old=${previous.mode};new=${input.mode}`,
	})
	return { previous, current }
}
