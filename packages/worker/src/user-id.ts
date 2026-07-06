import { toHex } from '@kody-internal/shared/hex.ts'

export async function createStableUserIdFromEmail(email: string) {
	const normalized = email.trim().toLowerCase()
	const data = new TextEncoder().encode(normalized)
	const hash = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(hash))
}

export type UserStableIdRow = {
	email: string
	stable_user_id?: string | null
}

export function normalizeStableUserId(value: string | null | undefined) {
	return value?.trim() ?? ''
}

export async function resolveUserStableId(row: UserStableIdRow) {
	const stored = normalizeStableUserId(row.stable_user_id)
	return stored || (await createStableUserIdFromEmail(row.email))
}

export async function findUserRowByStableUserId<
	T extends UserStableIdRow & { id: number },
>(input: {
	db: D1Database
	stableUserId: string
	select: string
}): Promise<T | null> {
	const stableUserId = normalizeStableUserId(input.stableUserId)
	if (!stableUserId) return null

	const storedRow = await input.db
		.prepare(`${input.select} WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<T>()
	if (storedRow) return storedRow

	const rows = await input.db.prepare(input.select).all<T>()
	for (const row of rows.results ?? []) {
		if ((await resolveUserStableId(row)) === stableUserId) return row
	}
	return null
}
