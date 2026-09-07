export const signupModes = ['invite', 'open', 'waitlist'] as const
export type SignupMode = (typeof signupModes)[number]
type SignupModeSource = 'kv' | 'env'

export type SignupModeSetting = {
	mode: SignupMode
	source: SignupModeSource
	envDefault: SignupMode
	updatedAt: string | null
	updatedBy: string | null
}

export function isSignupMode(value: unknown): value is SignupMode {
	return value === 'open' || value === 'waitlist' || value === 'invite'
}

/**
 * Conservative public fallback: unknown or missing values resolve to invite
 * so a stale payload cannot open signup copy.
 */
export function parseSignupMode(
	value: unknown,
	fallback: SignupMode = 'invite',
): SignupMode {
	return isSignupMode(value) ? value : fallback
}

export function getSignupMode(env: { SIGNUP_MODE?: SignupMode }): SignupMode {
	return parseSignupMode(env.SIGNUP_MODE)
}
