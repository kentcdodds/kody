import { type ProfileListLoaderData } from '#universal/loader-data.ts'

/**
 * Own-profile inventory includes private and hidden repositories. Keep that
 * list off the next `/@username` until it is known to belong to that username.
 */
export function profileListForUsername(
	list: ProfileListLoaderData | null,
	loadedForUsername: string | null,
	currentUsername: string,
): ProfileListLoaderData | null {
	if (list == null) return null
	if (loadedForUsername !== currentUsername) return null
	if (list.profile.username !== currentUsername) return null
	return list
}
