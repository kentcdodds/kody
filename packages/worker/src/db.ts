import { column as c, createDatabase, sql, table } from 'remix/data-table'
import { createD1DataTableAdapter } from './d1-data-table-adapter.ts'

export const usersTable = table({
	name: 'users',
	columns: {
		id: c.integer(),
		username: c.text(),
		email: c.text(),
		password_hash: c.text(),
		email_verified_at: c.text(),
		plan: c.text(),
		created_at: c.text(),
		updated_at: c.text(),
	},
	primaryKey: 'id',
})

export const passwordResetsTable = table({
	name: 'password_resets',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const emailVerificationsTable = table({
	name: 'email_verifications',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const invitesTable = table({
	name: 'invites',
	columns: {
		code: c.text(),
		created_by: c.integer(),
		note: c.text(),
		max_uses: c.integer(),
		use_count: c.integer(),
		expires_at: c.text(),
		revoked_at: c.text(),
		created_at: c.text(),
	},
	primaryKey: 'code',
})

export function createDb(db: D1Database) {
	return createDatabase(createD1DataTableAdapter(db), {
		now: () => new Date().toISOString(),
	})
}

export type AppDatabase = ReturnType<typeof createDb>
export { sql }
