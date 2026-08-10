import { type Action } from 'remix/router'
import { type routes } from '#universal/routes.ts'
import { createAuthPageHandler } from '#app/handlers/auth-page.ts'

export function createLoginHandler(env: Env) {
	return createAuthPageHandler(env, 'login') satisfies Action<
		typeof routes.login
	>
}
