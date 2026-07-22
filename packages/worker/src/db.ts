import { column as c, createDatabase, sql, table } from 'remix/data-table'
import { createD1DataTableAdapter } from './d1-data-table-adapter.ts'

export const usersTable = table({
	name: 'users',
	columns: {
		id: c.integer(),
		username: c.text(),
		email: c.text(),
		stable_user_id: c.text(),
		account_type: c.text(),
		display_name: c.text(),
		bio: c.text(),
		profile_visibility: c.text(),
		avatar_key: c.text(),
		password_hash: c.text(),
		email_verified_at: c.text(),
		plan: c.text(),
		stripe_customer_id: c.text(),
		stripe_plan: c.text(),
		stripe_plan_refreshed_at: c.text(),
		deleting_at: c.text(),
		active_write_count: c.integer(),
		active_write_expires_at: c.text(),
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

export const pendingEmailChangesTable = table({
	name: 'pending_email_changes',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		new_email: c.text(),
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
		plan: c.text(),
	},
	primaryKey: 'code',
})

export const oauthConnectionsTable = table({
	name: 'oauth_connections',
	columns: {
		id: c.integer(),
		provider_name: c.text(),
		provider_id: c.text(),
		user_id: c.integer(),
		provider_display_name: c.text(),
		created_at: c.text(),
		updated_at: c.text(),
	},
	primaryKey: 'id',
})

export function createDb(db: D1Database) {
	return createDatabase(createD1DataTableAdapter(db), {
		now: () => new Date().toISOString(),
	})
}

export type AppDatabase = ReturnType<typeof createDb>
export { sql }
