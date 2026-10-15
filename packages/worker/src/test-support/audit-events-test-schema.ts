/**
 * Workers-unit AUDIT_DB starts empty; production applies audit migration
 * `0001-audit-events.sql`. Suites whose requests write auth audit rows
 * (package-app ticket mints and denials) create the table first.
 */
export async function ensureAuditEventsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS audit_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				category TEXT NOT NULL,
				action TEXT NOT NULL,
				result TEXT NOT NULL,
				email_hash TEXT,
				ip_hash TEXT,
				client_id TEXT,
				path TEXT,
				reason TEXT,
				timestamp TEXT NOT NULL
			)`,
		)
		.run()
}
