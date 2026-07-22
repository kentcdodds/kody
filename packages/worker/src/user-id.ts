import { toHex } from '@kody-internal/shared/hex.ts'

/**
 * Initial stable MCP user id for a new account: SHA-256 hex of the trimmed
 * lowercase email. After signup the stored `users.stable_user_id` is
 * authoritative and must not be recomputed when the account email changes.
 */
export async function createStableUserIdFromEmail(email: string) {
	const normalized = email.trim().toLowerCase()
	const data = new TextEncoder().encode(normalized)
	const hash = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(hash))
}

export function normalizeStableUserId(value: string | null | undefined) {
	return value?.trim() ?? ''
}

/**
 * Read the authoritative stored stable id. `users.stable_user_id` is NOT NULL
 * (migration 0075); never derive identity from the current email here — email
 * changes preserve the original stored id.
 */
export function resolveUserStableId(row: {
	stable_user_id: string | null | undefined
}) {
	const stored = normalizeStableUserId(row.stable_user_id)
	if (!stored) {
		throw new Error('users.stable_user_id is required')
	}
	return stored
}
