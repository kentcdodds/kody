import { type BuildAction } from 'remix/fetch-router'
import { type routes } from '#server/routes.ts'
import { createAuthPageHandler } from './auth-page.ts'

export const login = createAuthPageHandler() satisfies BuildAction<
	typeof routes.login.method,
	typeof routes.login.pattern
>
