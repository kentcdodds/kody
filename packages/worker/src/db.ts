import { createDatabase, createTable, sql } from 'remix/data-table'
import { nullable, number, optional, string } from 'remix/data-schema'
import { createD1DataTableAdapter } from './d1-data-table-adapter.ts'

export const usersTable = createTable({
	name: 'users',
	columns: {
		id: number(),
		username: string(),
		email: string(),
		password_hash: string(),
		created_at: string(),
		updated_at: string(),
	},
	primaryKey: 'id',
})

export const passwordResetsTable = createTable({
	name: 'password_resets',
	columns: {
		id: number(),
		user_id: number(),
		token_hash: string(),
		expires_at: number(),
		created_at: string(),
	},
	primaryKey: 'id',
})

export const mockResendMessagesTable = createTable({
	name: 'mock_resend_messages',
	columns: {
		id: string(),
		token_hash: string(),
		received_at: number(),
		from_email: string(),
		to_json: string(),
		subject: string(),
		html: string(),
		payload_json: string(),
	},
	primaryKey: 'id',
})

export const chatThreadsTable = createTable({
	name: 'chat_threads',
	columns: {
		id: string(),
		user_id: number(),
		title: string(),
		last_message_preview: string(),
		message_count: number(),
		created_at: string(),
		updated_at: string(),
		deleted_at: optional(nullable(string())),
	},
	primaryKey: 'id',
	timestamps: {
		createdAt: 'created_at',
		updatedAt: 'updated_at',
	},
})

export const mockAiRequestsTable = createTable({
	name: 'mock_ai_requests',
	columns: {
		id: string(),
		token_hash: string(),
		received_at: number(),
		scenario: string(),
		last_user_message: string(),
		tool_names_json: string(),
		request_json: string(),
		response_text: string(),
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
