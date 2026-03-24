import { type BuildAction } from 'remix/fetch-router'
import { type routes } from '#app/routes.ts'
import { createAuthPageHandler } from '#app/handlers/auth-page.ts'

export const signup = createAuthPageHandler() satisfies BuildAction<
	typeof routes.signup.method,
	typeof routes.signup.pattern
>
