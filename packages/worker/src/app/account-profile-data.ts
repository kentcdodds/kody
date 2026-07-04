import { type AccountProfileLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export function buildAccountProfilePayload(
	user: AuthenticatedUser,
): AccountProfileLoaderData {
	return {
		ok: true,
		email: user.email,
		username: user.username,
		displayName: user.displayName,
	}
}

export async function loadAccountProfileData(
	user: AuthenticatedUser,
): Promise<AccountProfileLoaderData> {
	return buildAccountProfilePayload(user)
}
