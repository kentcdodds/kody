import { normalizeEmail } from '#app/normalize-email.ts'
import { isReservedUsername } from '#app/reserved-usernames.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

/**
 * The email domain every user inbox and user outbound sender lives on:
 * the hostname of `APP_BASE_URL` (for example `heykody.dev`). Returns null
 * when the deployment has no configured base URL, in which case user email
 * addressing is unavailable.
 */
export function getPlatformEmailDomain(env: {
	APP_BASE_URL?: string | null
}): string | null {
	const configuredBaseUrl = env.APP_BASE_URL?.trim()
	if (!configuredBaseUrl) return null
	try {
		const hostname = new URL(configuredBaseUrl).hostname.toLowerCase()
		return hostname.length > 0 ? hostname : null
	} catch {
		return null
	}
}

export function buildPlatformEmailAddress(input: {
	username: string
	domain: string
}) {
	return `${input.username.trim().toLowerCase()}@${input.domain}`
}

async function findUserAccount(input: {
	db: D1Database
	accountEmail: string | null | undefined
	userId: string
}): Promise<{ email: string; username: string | null } | null> {
	const userId = input.userId.trim()
	if (!userId) return null
	// The stable userId is the authoritative identity: a caller-supplied
	// email is only trusted (as an indexed lookup) when it hashes to that
	// userId, so a mismatched pair can never yield another account's
	// platform sender address.
	const email = normalizeEmail(input.accountEmail ?? '')
	if (email && (await createStableUserIdFromEmail(email)) === userId) {
		const row = await input.db
			.prepare(`SELECT username FROM users WHERE email = ?`)
			.bind(email)
			.first<{ username: string | null }>()
		if (!row) return null
		return { email, username: row.username?.trim().toLowerCase() || null }
	}
	// Package runtime contexts (for example email subscription handlers) act
	// with the stable hashed userId but no account email; resolve the account
	// the same way isAccountEmailVerified does.
	const rows = await input.db
		.prepare(`SELECT email, username FROM users`)
		.all<{ email: string; username: string | null }>()
	for (const row of rows.results ?? []) {
		if ((await createStableUserIdFromEmail(row.email)) === userId) {
			return {
				email: normalizeEmail(row.email),
				username: row.username?.trim().toLowerCase() || null,
			}
		}
	}
	return null
}

export type ResolvedPlatformSender = {
	/** Platform-assigned from address: {username}@<platform domain>. */
	from: string
	/**
	 * The account email backing the acting userId, resolved even when the
	 * caller context carried none, so plan/entitlement lookups always bind.
	 */
	accountEmail: string
	username: string
	domain: string
}

/**
 * Resolve the platform-assigned outbound sender (`{username}@<platform
 * domain>`) and the backing account email for the acting user. The from
 * address is never caller-supplied: it always derives from the account's
 * username, and reserved/system local parts (including `kody@`, the
 * transactional system sender) can never send user mail.
 */
export async function resolveUserPlatformSender(input: {
	db: D1Database
	env: { APP_BASE_URL?: string | null }
	accountEmail: string | null | undefined
	userId: string
}): Promise<ResolvedPlatformSender> {
	const domain = getPlatformEmailDomain(input.env)
	if (!domain) {
		throw new Error(
			'Outbound email is unavailable because no platform email domain is configured.',
		)
	}
	const account = await findUserAccount(input)
	if (!account) {
		throw new Error('A signed-in account email is required to send email.')
	}
	if (!account.username) {
		throw new Error('No account username found for outbound email.')
	}
	if (isReservedUsername(account.username)) {
		throw new Error(
			'Reserved usernames cannot send email; they are limited to system mail.',
		)
	}
	return {
		from: buildPlatformEmailAddress({ username: account.username, domain }),
		accountEmail: account.email,
		username: account.username,
		domain,
	}
}
