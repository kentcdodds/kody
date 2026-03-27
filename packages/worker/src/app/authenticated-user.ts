import {
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { getEnv } from '#app/env.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

export type AuthenticatedAppUser = {
	sessionUserId: string
	userId: number
	email: string
	displayName: string
	mcpUser: McpUserContext
	artifactOwnerIds: Array<string>
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

	const emailBasedUserId = await createStableUserIdFromEmail(session.email)

	return {
		sessionUserId: session.id,
		userId,
		email: session.email,
		displayName: buildDisplayName(session.email),
		artifactOwnerIds: Array.from(
			new Set([session.id, emailBasedUserId].filter(Boolean)),
		),
		mcpUser: {
			userId: emailBasedUserId,
			email: session.email,
			displayName: buildDisplayName(session.email),
		},
	} satisfies AuthenticatedAppUser
}
