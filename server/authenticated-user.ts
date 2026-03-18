import {
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#server/auth-session.ts'
import { getEnv } from '#server/env.ts'
import { type McpUserContext } from '#shared/chat.ts'

export type AuthenticatedAppUser = {
	sessionUserId: string
	userId: number
	email: string
	displayName: string
	mcpUser: McpUserContext
}

function buildDisplayName(email: string) {
	return email.split('@')[0] || 'user'
}

export async function readAuthenticatedAppUser(request: Request, env: Env) {
	const appEnv = getEnv(env)
	setAuthSessionSecret(appEnv.COOKIE_SECRET)
	const { session } = await readAuthSessionResult(request)
	if (!session) return null

	const userId = Number.parseInt(session.id, 10)
	if (!Number.isFinite(userId)) return null

	return {
		sessionUserId: session.id,
		userId,
		email: session.email,
		displayName: buildDisplayName(session.email),
		mcpUser: {
			userId: session.id,
			email: session.email,
			displayName: buildDisplayName(session.email),
		},
	} satisfies AuthenticatedAppUser
}
