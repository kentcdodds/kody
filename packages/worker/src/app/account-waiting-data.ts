import { type AccountWaitingLoaderData } from '#universal/loader-data.ts'
import { deriveWaitingItems } from '#mcp/waiting/derive-waiting.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountWaitingData(input: {
	env: Env
	user: AuthenticatedUser
	now?: Date
}): Promise<AccountWaitingLoaderData> {
	const items = await deriveWaitingItems({
		env: input.env,
		user: {
			userId: input.user.userId,
			stableUserId: input.user.mcpUser.userId,
			email: input.user.email,
			username: input.user.username,
			emailVerified: input.user.emailVerified,
		},
		now: input.now,
	})
	return {
		ok: true,
		items,
	}
}
