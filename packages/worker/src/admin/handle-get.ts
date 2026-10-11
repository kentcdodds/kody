/**
 * soft-delete-read-filter: opt-out
 *
 * Admin handle lookup must see tombstoned users and orgs so an operator can
 * tell whether a name is still held during the restore window. This read is
 * not a public search path: profile pages, package URLs, and search indexes
 * keep their live-row filters and must not call this function.
 */
import {
	compactReservedUsername,
	reservedUsernameSeparatorCharacters,
} from '#worker/identity/reserved-usernames.ts'

const handleHolderLimit = 50

type AdminHandleSource = 'handle' | 'org' | 'user'
type AdminHandleOwnerKind = 'user' | 'org'

type AdminHandleHolder = {
	source: AdminHandleSource
	ownerKind: AdminHandleOwnerKind | null
	id: string | null
	storedHandle: string
	createdAt: string
	deletedAt: string | null
}

type AdminHandleLookup = {
	compact: string
	holders: Array<AdminHandleHolder>
	truncated: boolean
}

type HandleHolderRow = {
	source: string
	owner_kind: string | null
	owner_id: string | null
	stored_handle: string
	created_at: string
	deleted_at: string | null
}

function compactStoredHandleSql(column: string) {
	if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(column)) {
		throw new Error(`Unsafe handle column: ${column}`)
	}
	let expression = `lower(${column})`
	for (const separator of reservedUsernameSeparatorCharacters) {
		switch (separator) {
			case '-':
			case '_':
				expression = `replace(${expression}, '${separator}', '')`
				break
			default: {
				const unexpected: never = separator
				throw new Error(
					`Unsupported reserved-username separator: ${unexpected}`,
				)
			}
		}
	}
	return expression
}

function parseSource(value: string): AdminHandleSource {
	switch (value) {
		case 'handle':
		case 'org':
		case 'user':
			return value
		default: {
			throw new Error(`Unexpected handle holder source: ${value}`)
		}
	}
}

function parseOwnerKind(value: string | null): AdminHandleOwnerKind | null {
	switch (value) {
		case null:
			return null
		case 'user':
		case 'org':
			return value
		default: {
			throw new Error(`Unexpected handle owner kind: ${value}`)
		}
	}
}

function holderFromRow(row: HandleHolderRow): AdminHandleHolder {
	return {
		source: parseSource(row.source),
		ownerKind: parseOwnerKind(row.owner_kind),
		id: row.owner_id,
		storedHandle: row.stored_handle,
		createdAt: row.created_at,
		deletedAt: row.deleted_at,
	}
}

/**
 * Resolve one handle across `handles`, `orgs.slug`, and `users.username`.
 * Match is case-insensitive and separator-stripped, using the same hyphen and
 * underscore compaction as reserved-name checks. Soft-deleted owner rows are
 * included. The result is owner metadata only: no email or other account content.
 */
export async function loadAdminHandleHolders(
	db: D1Database,
	handle: string,
): Promise<AdminHandleLookup> {
	const compact = compactReservedUsername(handle)
	if (!compact) {
		throw new Error('Handle is empty after reserved-name compaction.')
	}
	const handleCompact = compactStoredHandleSql('h.handle')
	const slugCompact = compactStoredHandleSql('slug')
	const usernameCompact = compactStoredHandleSql('username')
	const rows = await db
		.prepare(
			`SELECT source, owner_kind, owner_id, stored_handle, created_at, deleted_at
			 FROM (
			   SELECT
			     'handle' AS source,
			     CASE
			       WHEN h.org_id IS NOT NULL THEN 'org'
			       WHEN h.user_id IS NOT NULL THEN 'user'
			       ELSE NULL
			     END AS owner_kind,
			     COALESCE(h.org_id, h.user_id) AS owner_id,
			     h.handle AS stored_handle,
			     h.created_at AS created_at,
			     CASE
			       WHEN h.org_id IS NOT NULL THEN o.deleted_at
			       WHEN h.user_id IS NOT NULL THEN u.deleted_at
			       ELSE NULL
			     END AS deleted_at
			   FROM handles h
			   LEFT JOIN orgs o ON o.id = h.org_id
			   LEFT JOIN users u ON u.stable_user_id = h.user_id
			   WHERE ${handleCompact} = ?
			   UNION ALL
			   SELECT
			     'org' AS source,
			     'org' AS owner_kind,
			     id AS owner_id,
			     slug AS stored_handle,
			     created_at,
			     deleted_at
			   FROM orgs
			   WHERE ${slugCompact} = ?
			   UNION ALL
			   SELECT
			     'user' AS source,
			     'user' AS owner_kind,
			     stable_user_id AS owner_id,
			     username AS stored_handle,
			     created_at,
			     deleted_at
			   FROM users
			   WHERE ${usernameCompact} = ?
			 ) AS matched
			 ORDER BY
			   CASE source WHEN 'handle' THEN 0 WHEN 'org' THEN 1 ELSE 2 END,
			   stored_handle
			 LIMIT ?`,
		)
		.bind(compact, compact, compact, handleHolderLimit + 1)
		.all<HandleHolderRow>()
	const matched = rows.results ?? []
	const truncated = matched.length > handleHolderLimit
	return {
		compact,
		holders: matched.slice(0, handleHolderLimit).map(holderFromRow),
		truncated,
	}
}
