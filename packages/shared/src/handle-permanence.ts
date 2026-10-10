/**
 * Handles (the `@slug` in `kody.codes/@slug`) are permanent for every
 * organization, personal and team alike. Every surface that picks or edits a
 * handle shows the same words so people choose deliberately.
 */

export const handlePermanentNote =
	'Handles are permanent and cannot be changed later.'

export const orgSlugPermanentError =
	'Organization handles are permanent and cannot be changed. You can change the display name instead.'

export const usernamePermanentError =
	'Usernames are permanent and cannot be changed. You can change your display name instead.'

export function handleUrlPreview(slug: string) {
	return `kody.codes/@${slug}`
}
