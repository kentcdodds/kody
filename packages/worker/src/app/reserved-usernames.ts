/**
 * Usernames that can never be claimed by users. Because every user gets an
 * automatic email inbox at `{username}@<platform domain>`, a reserved
 * username is also a reserved email local part: `kody@` is the system
 * transactional sender and the rest are role addresses (RFC 2142) or
 * infrastructure names that must never route to a user inbox or be usable
 * as a user outbound sender.
 *
 * This list only gates username acquisition (signup, profile updates, admin
 * user creation) and email routing. Validation of already-stored usernames
 * stays purely syntactic so legacy accounts keep working outside of email.
 */
export const reservedUsernames = new Set([
	// System sender: kody@<domain> is transactional-only, never a user inbox.
	'kody',
	// Role and operational addresses (RFC 2142 and common conventions).
	'abuse',
	'admin',
	'administrator',
	'alert',
	'alerts',
	'billing',
	'bounce',
	'bounces',
	'contact',
	'daemon',
	'email',
	'ftp',
	'help',
	'hostmaster',
	'imap',
	'inbox',
	'info',
	'legal',
	'mail',
	'mailer-daemon',
	'marketing',
	'moderator',
	'news',
	'no-reply',
	'noc',
	'noreply',
	'notification',
	'notifications',
	'official',
	'owner',
	'postmaster',
	'privacy',
	'reply',
	'root',
	'sales',
	'security',
	'smtp',
	'staff',
	'support',
	'system',
	'team',
	'usenet',
	'uucp',
	'webmaster',
	'www',
])

/**
 * Local parts shaped like the legacy inbound reply-token aliases
 * (`kody-r-<hex>`). Reserved so a user can never register a username that
 * collides with that address space.
 */
const reservedUsernamePrefixPattern = /^kody-r-/

export function isReservedUsername(value: string) {
	const username = value.trim().toLowerCase()
	if (!username) return false
	return (
		reservedUsernames.has(username) ||
		reservedUsernamePrefixPattern.test(username)
	)
}

export function getReservedUsernameError(username: string) {
	return isReservedUsername(username)
		? 'This username is reserved and cannot be registered.'
		: null
}
