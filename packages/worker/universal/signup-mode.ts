export const signupModes = ['invite', 'open', 'waitlist'] as const
export type SignupMode = (typeof signupModes)[number]
export type SignupModeSource = 'kv' | 'env'

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

export function getSignupMode(env: { SIGNUP_MODE?: SignupMode }): SignupMode {
	return isSignupMode(env.SIGNUP_MODE) ? env.SIGNUP_MODE : 'invite'
}
