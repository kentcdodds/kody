import { buildUserAvatarUrl } from '#app/community-public.ts'
import {
	type AccountProfileLoaderData,
	type ProfileVisibility,
} from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createDb, usersTable } from '#worker/db.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

function asProfileVisibility(
	value: string | null | undefined,
): ProfileVisibility {
	return value === 'private' ? 'private' : 'public'
}

export function buildAccountProfilePayload(
	user: AuthenticatedUser,
	profileFields?: {
		displayName?: string | null
		bio?: string | null
		avatarKey?: string | null
		profileVisibility?: ProfileVisibility
	},
): AccountProfileLoaderData {
	const rawDisplayName = profileFields?.displayName
	return {
		ok: true,
		email: user.email,
		emailVerified: user.emailVerified,
		username: user.username,
		// Prefer an explicit community display name; otherwise fall back to the
		// auth display name (username) so existing username-only clients keep a
		// sensible value.
		displayName:
			rawDisplayName != null && rawDisplayName.trim().length > 0
				? rawDisplayName.trim()
				: user.displayName || user.username,
		bio: profileFields?.bio ?? null,
		avatarUrl: buildUserAvatarUrl({
			username: user.username,
			avatarKey: profileFields?.avatarKey ?? null,
		}),
		profileVisibility: profileFields?.profileVisibility ?? 'public',
	}
}

/**
 * Load account profile settings. When `env` is provided, reads community
 * profile fields from the users row so the settings form shows persisted
 * display name / bio / visibility / avatar.
 */
export async function loadAccountProfileData(
	user: AuthenticatedUser,
	env?: Env,
): Promise<AccountProfileLoaderData> {
	if (!env) {
		return buildAccountProfilePayload(user)
	}

	const db = createDb(env.APP_DB)
	const row = await db.findOne(usersTable, { where: { id: user.userId } })
	if (!row) {
		return buildAccountProfilePayload(user)
	}

	return buildAccountProfilePayload(user, {
		displayName: row.display_name,
		bio: row.bio,
		avatarKey: row.avatar_key,
		profileVisibility: asProfileVisibility(row.profile_visibility),
	})
}
