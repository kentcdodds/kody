import { isValidRemoteConnectorName } from '@kody-internal/shared/remote-connectors.ts'

export type UserRepoRow = {
	id: string
	user_id: string
	name: string
	description: string | null
	created_at: string
	updated_at: string
}

export type UserRepoRecord = {
	id: string
	userId: string
	name: string
	description: string | null
	createdAt: string
	updatedAt: string
}

export const plainRepoPromotionNotice =
	'This repo exists but is not a package — promote it with repo_promote_to_package.'

export const plainRepoPackageShapedNotice =
	'Root package.json detected at HEAD. Promote with repo_promote_to_package to activate package runtime surfaces.'

function mapUserRepoRow(row: Record<string, unknown>): UserRepoRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		name: String(row['name']),
		description: row['description'] == null ? null : String(row['description']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export function normalizeUserRepoName(name: string) {
	return name.trim().toLowerCase()
}

export function assertValidUserRepoName(name: string) {
	const normalized = normalizeUserRepoName(name)
	if (!normalized) {
		throw new Error('Repo name is required.')
	}
	if (!isValidRemoteConnectorName(normalized)) {
		throw new Error(
			'Repo name must use lowercase letters, numbers, and dashes; start and end with a letter or number; and be at most 64 characters.',
		)
	}
	return normalized
}

export async function insertUserRepo(
	db: D1Database,
	row: Omit<UserRepoRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
) {
	const now = new Date().toISOString()
	// Writer contract: names are stored normalized so getUserRepoByName's
	// normalized lookups always match, regardless of caller.
	const name = assertValidUserRepoName(row.name)
	await db
		.prepare(
			`INSERT INTO user_repos (
				id, user_id, name, description, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			name,
			row.description,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getUserRepoById(
	db: D1Database,
	input: { userId: string; repoId: string },
): Promise<UserRepoRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, name, description, created_at, updated_at
			FROM user_repos
			WHERE user_id = ? AND id = ?`,
		)
		.bind(input.userId, input.repoId)
		.first<Record<string, unknown>>()
	return row ? mapUserRepoRow(row) : null
}

export async function getUserRepoByName(
	db: D1Database,
	input: { userId: string; name: string },
): Promise<UserRepoRecord | null> {
	const normalized = normalizeUserRepoName(input.name)
	const row = await db
		.prepare(
			`SELECT id, user_id, name, description, created_at, updated_at
			FROM user_repos
			WHERE user_id = ? AND name = ?`,
		)
		.bind(input.userId, normalized)
		.first<Record<string, unknown>>()
	return row ? mapUserRepoRow(row) : null
}

export async function listUserRepos(
	db: D1Database,
	userId: string,
): Promise<Array<UserRepoRecord>> {
	const result = await db
		.prepare(
			`SELECT id, user_id, name, description, created_at, updated_at
			FROM user_repos
			WHERE user_id = ?
			ORDER BY name ASC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapUserRepoRow)
}

export async function deleteUserRepo(
	db: D1Database,
	input: { userId: string; repoId: string },
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM user_repos WHERE user_id = ? AND id = ?`)
		.bind(input.userId, input.repoId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function renameUserRepo(
	db: D1Database,
	input: { userId: string; repoId: string; name: string },
): Promise<boolean> {
	const name = assertValidUserRepoName(input.name)
	const result = await db
		.prepare(
			`UPDATE user_repos
			SET name = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(name, new Date().toISOString(), input.userId, input.repoId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Cheap miss-path helper: when a saved-package lookup fails, check whether a
 * plain repo with the same bare name exists for promotion guidance.
 */
export async function findPlainRepoPromotionHint(
	db: D1Database,
	input: { userId: string; packageIdOrKodyId: string },
): Promise<UserRepoRecord | null> {
	const trimmed = input.packageIdOrKodyId.trim()
	if (!trimmed) return null
	const scopedSuffix = trimmed.includes('/')
		? trimmed.split('/').pop()?.trim()
		: trimmed
	if (!scopedSuffix) return null
	const byName = await getUserRepoByName(db, {
		userId: input.userId,
		name: scopedSuffix,
	})
	if (byName) return byName
	return await getUserRepoById(db, {
		userId: input.userId,
		repoId: trimmed,
	})
}

export function buildPlainRepoPromotionErrorMessage(packageIdOrKodyId: string) {
	return `${plainRepoPromotionNotice} (lookup: ${JSON.stringify(packageIdOrKodyId)}).`
}
