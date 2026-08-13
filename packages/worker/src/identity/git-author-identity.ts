import { z } from 'zod'
import { displayNameFromEmail } from '#worker/identity/username.ts'

export type GitAuthorIdentity = {
	name: string
	email: string
}

export const gitAuthorIdentitySchema = z
	.object({
		name: z
			.string()
			.describe(
				'Signed-in Kody account display name. Use as git user.name; do not guess a name.',
			),
		email: z
			.email()
			.describe(
				'Signed-in Kody account email. Use as git user.email; never invent an email.',
			),
	})
	.describe(
		'Git author for this clone: the signed-in Kody account. setup_commands set local user.name and user.email to these values.',
	)

export function shellQuote(value: string) {
	return `'${value.replaceAll(`'`, `'"'"'`)}'`
}

function sanitizeGitIdentityValue(value: string) {
	return value.replaceAll(/[\r\n]+/g, ' ').trim()
}

/**
 * Git author for Kody Artifacts remotes: the signed-in account, never a
 * guessed name or email.
 */
export function gitAuthorIdentityFromUser(user: {
	email: string
	displayName?: string | null
}): GitAuthorIdentity {
	const email = sanitizeGitIdentityValue(user.email)
	if (!email) {
		throw new Error(
			'Signed-in Kody account email is required for git author identity.',
		)
	}
	const name =
		sanitizeGitIdentityValue(user.displayName ?? '') ||
		displayNameFromEmail(email)
	return { name, email }
}

/** Local-repo git config commands; run after `cd` into the clone. */
export function gitAuthorSetupCommands(author: GitAuthorIdentity) {
	return [
		`git config --local user.email -- ${shellQuote(author.email)}`,
		`git config --local user.name -- ${shellQuote(author.name)}`,
	]
}
