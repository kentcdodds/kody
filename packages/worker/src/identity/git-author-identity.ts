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

/**
 * Local-repo git config commands; run after `cd` into the clone.
 *
 * Put `--` before the config key (not between key and value). The old form
 * `git config --local user.email -- 'addr'` stores the literal `--` as the
 * value (git treats `--` as the value and the quoted address as a value-pattern),
 * which produced Artifacts commits authored as `-- <-->`.
 */
export function gitAuthorSetupCommands(author: GitAuthorIdentity) {
	const email = sanitizeGitIdentityValue(author.email)
	const name = sanitizeGitIdentityValue(author.name)
	if (!email || !name || email === '--' || name === '--') {
		throw new Error(
			'Git author name and email must be non-empty and must not be "--".',
		)
	}
	return [
		`git config --local -- user.email ${shellQuote(email)}`,
		`git config --local -- user.name ${shellQuote(name)}`,
	]
}
