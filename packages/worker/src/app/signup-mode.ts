export const signupModes = ['invite', 'open', 'waitlist'] as const
export type SignupMode = (typeof signupModes)[number]

export function getSignupMode(env: { SIGNUP_MODE?: SignupMode }): SignupMode {
	const mode = env.SIGNUP_MODE
	return mode === 'open' || mode === 'waitlist' || mode === 'invite'
		? mode
		: 'invite'
}
