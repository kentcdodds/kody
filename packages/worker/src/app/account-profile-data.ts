import { createDb, usersTable } from '#worker/db.ts'
import { type AccountProfileLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { hasUsablePasswordHash } from '@kody-internal/shared/password-hash.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export function buildAccountProfilePayload(
	user: AuthenticatedUser,
	hasUsablePassword: boolean,
): AccountProfileLoaderData {
	return {
		ok: true,
		email: user.email,
		emailVerified: user.emailVerified,
		username: user.username,
		displayName: user.displayName,
		hasUsablePassword,
	}
}

export async function loadAccountProfileData(
	user: AuthenticatedUser,
	env: Env,
): Promise<AccountProfileLoaderData> {
	const db = createDb(env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { id: user.userId },
	})
	return buildAccountProfilePayload(
		user,
		hasUsablePasswordHash(userRecord?.password_hash ?? ''),
	)
}
