import { type Action } from 'remix/router'
import { type routes } from '#app/routes.ts'
import { createAuthPageHandler } from '#app/handlers/auth-page.ts'

export const login = createAuthPageHandler() satisfies Action<
	typeof routes.login
>
