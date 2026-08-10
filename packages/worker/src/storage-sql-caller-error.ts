/**
 * Caller-clearable failures from user-authored SQL against a durable storage
 * bucket (storage_query / storage.sql). Cloudflare Durable Object SQL surfaces
 * SQLite failures as `<detail>: SQLITE_<CODE>` (for example
 * `no such table: articles: SQLITE_ERROR`). Policy denials thrown by
 * storage-runner before exec use stable `storage.sql …` / `Read-only
 * storage.sql …` prefixes.
 *
 * Transient lock codes (BUSY / LOCKED) stay out of this matcher so platform
 * contention is not mislabeled as a caller mistake.
 */
const userStorageSqliteErrorPattern =
	/:\s*SQLITE_(?!BUSY\b|LOCKED\b)[A-Z0-9_]+\s*$/

export function isUserStorageSqlCallerMessage(message: string) {
	if (userStorageSqliteErrorPattern.test(message)) return true
	if (message.startsWith('storage.sql ')) return true
	if (message.startsWith('Read-only storage.sql ')) return true
	return false
}
