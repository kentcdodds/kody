import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'

export function createD1FromSqlite(db: DatabaseSync) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
				async all<T>() {
					const statement = db.prepare(query)
					const rows = statement.all() as Array<T>
					return { results: rows, meta: { changes: 0 } }
				},
				async first<T>() {
					const statement = db.prepare(query)
					return (statement.get() ?? null) as T | null
				},
				async run() {
					const statement = db.prepare(query)
					const result = statement.run()
					return { meta: { changes: result.changes } }
				},
			}
		},
		async batch(
			statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>,
		) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
	} as unknown as D1Database
}

export function emptyCleanup() {
	return { scanned: 0, deleted: 0, failed: 0 }
}

export function createEmailMessagesDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			raw_mime TEXT,
			raw_mime_key TEXT,
			raw_mime_offload_blocked INTEGER NOT NULL DEFAULT 0
				CHECK (raw_mime_offload_blocked IN (0, 1)),
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE email_attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			storage_key TEXT,
			content_type TEXT NOT NULL DEFAULT 'text/plain',
			size INTEGER NOT NULL DEFAULT 0,
			storage_kind TEXT NOT NULL DEFAULT 'raw-mime',
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE email_raw_mime_cleanup_queue (
			object_key TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX idx_email_messages_raw_mime_offload_unblocked
		ON email_messages (id)
		WHERE raw_mime IS NOT NULL AND raw_mime_offload_blocked = 0;
		CREATE INDEX idx_email_raw_mime_cleanup_queue_user_id
		ON email_raw_mime_cleanup_queue (user_id);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

export function readCleanupQueue(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			`SELECT object_key, user_id, message_id, attempt_count, last_error
			FROM email_raw_mime_cleanup_queue
			ORDER BY object_key`,
		)
		.all() as Array<{
		object_key: string
		user_id: string
		message_id: string
		attempt_count: number
		last_error: string | null
	}>
}

export function insertMessage(
	sqlite: DatabaseSync,
	input: {
		id: string
		userId: string
		rawMime?: string | null
		rawMimeKey?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, raw_mime, raw_mime_key)
			VALUES (?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.rawMime ?? null,
			input.rawMimeKey ?? null,
		)
}

export function readMessage(sqlite: DatabaseSync, id: string) {
	return sqlite
		.prepare(
			`SELECT id, user_id, raw_mime, raw_mime_key, raw_mime_offload_blocked
			FROM email_messages
			WHERE id = ?`,
		)
		.get(id) as {
		id: string
		user_id: string
		raw_mime: string | null
		raw_mime_key: string | null
		raw_mime_offload_blocked: number
	} | null
}

export function createMemoryBlobs(options?: {
	failPutForKeys?: ReadonlySet<string>
	deleteImpl?: (key: string, store: Map<string, string>) => Promise<void>
}) {
	const store = new Map<string, string>()
	const put = vi.fn(async (key: string, value: string | ArrayBuffer | Blob) => {
		if (options?.failPutForKeys?.has(key)) {
			throw new Error(`r2-put-failed:${key}`)
		}
		const text =
			typeof value === 'string'
				? value
				: value instanceof Blob
					? await value.text()
					: new TextDecoder().decode(value)
		store.set(key, text)
	})
	const del = vi.fn(async (key: string) => {
		if (options?.deleteImpl) {
			await options.deleteImpl(key, store)
			return
		}
		store.delete(key)
	})
	return {
		store,
		blobs: { put, delete: del } as unknown as R2Bucket,
		put,
		del,
	}
}

export function createCasMissDb(
	sqlite: DatabaseSync,
	baseDb: D1Database,
	behavior: (id: string, key: string, userId: string) => 'delete-row' | 'miss',
) {
	return {
		prepare(query: string) {
			if (query.includes('UPDATE email_messages')) {
				return {
					bind(...params: Array<unknown>) {
						const key = String(params[0])
						const id = String(params[2])
						const userId = String(params[3])
						return {
							async run() {
								const action = behavior(id, key, userId)
								if (action === 'delete-row') {
									sqlite
										.prepare(`DELETE FROM email_messages WHERE id = ?`)
										.run(id)
									return { meta: { changes: 0 } }
								}
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			}
			return baseDb.prepare(query)
		},
	} as unknown as D1Database
}

export function createOffloadRequest(
	input: { method?: string; authorization?: string } = {},
) {
	return new Request(
		'https://kody.example.com/__maintenance/offload-email-raw-mime',
		{
			method: input.method ?? 'POST',
			headers:
				input.authorization === undefined
					? undefined
					: { Authorization: input.authorization },
		},
	)
}
