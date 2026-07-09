import { type Action } from 'remix/router'
import { type routes } from '#app/routes.ts'
import { createAuthPageHandler } from '#app/handlers/auth-page.ts'

export function createSignupHandler(env: Env) {
	return createAuthPageHandler(env, 'signup') satisfies Action<
		typeof routes.signup
	>
}
