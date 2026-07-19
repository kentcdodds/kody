import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { platformFeedbackContentWarning } from '#worker/platform-feedback/content-warning.ts'
import { loadAdminPlatformFeedbackData } from './admin-platform-feedback-data.ts'

type TestD1Statement = {
	bind(...params: Array<unknown>): TestD1Statement
	all<T>(): Promise<{ results: Array<T>; meta: { changes: number } }>
	first<T>(): Promise<T | null>
	run(): Promise<{ meta: { changes: number } }>
}

function createD1FromSqlite(sqlite: DatabaseSync) {
	function createStatement(
		query: string,
		params: Array<unknown> = [],
	): TestD1Statement {
		return {
			bind(...boundParams: Array<unknown>) {
				return createStatement(query, boundParams)
			},
			async all<T>() {
				return {
					results: sqlite.prepare(query).all(...params) as Array<T>,
					meta: { changes: 0 },
				}
			},
			async first<T>() {
				return (sqlite.prepare(query).get(...params) ?? null) as T | null
			},
			async run() {
				const result = sqlite.prepare(query).run(...params)
				return { meta: { changes: result.changes } }
			},
		}
	}

	return {
		prepare(query: string) {
			return createStatement(query)
		},
	} as unknown as D1Database
}

function createAdminPlatformFeedbackFixture() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			stable_user_id TEXT,
			private_content TEXT
		);
		CREATE UNIQUE INDEX idx_users_stable_user_id
			ON users(stable_user_id)
			WHERE stable_user_id IS NOT NULL;
	`)
	sqlite.exec(
		readFileSync(
			new URL('../../migrations/0062-platform-feedback.sql', import.meta.url),
			'utf8',
		),
	)
	sqlite
		.prepare(
			`INSERT INTO users (
				id, username, email, stable_user_id, private_content
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			1,
			'active-submitter',
			'active@example.com',
			'stable-active',
			'ACTIVE_PRIVATE_CONTENT_MUST_NOT_LEAK',
		)
	sqlite
		.prepare(
			`INSERT INTO users (
				id, username, email, stable_user_id, private_content
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			2,
			'other-user',
			'other@example.com',
			'stable-other',
			'OTHER_USER_CONTENT_MUST_NOT_LEAK',
		)
	const insertFeedback = sqlite.prepare(
		`INSERT INTO platform_feedback (
			id, submitter_user_id, category, summary, details, status,
			reviewed_by_user_id, reviewed_at, admin_note, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	insertFeedback.run(
		'feedback-active',
		'stable-active',
		'bug',
		'<script>summary remains text</script>',
		'Full active feedback details.',
		'triaged',
		'stable-reviewer',
		'2026-07-19T01:30:00.000Z',
		'Follow up with the submitter.',
		'2026-07-19T01:00:00.000Z',
		'2026-07-19T01:30:00.000Z',
	)
	insertFeedback.run(
		'feedback-missing',
		'stable-deleted',
		'suggestion',
		'Missing submitter account',
		'The feedback remains after the submitter identity is unavailable.',
		'open',
		null,
		null,
		null,
		'2026-07-19T00:00:00.000Z',
		'2026-07-19T00:00:00.000Z',
	)
	return {
		sqlite,
		env: { APP_DB: createD1FromSqlite(sqlite) } as Env,
	}
}

test('admin platform feedback data lists safely and resolves identity only for selected feedback', async () => {
	const { sqlite, env } = createAdminPlatformFeedbackFixture()

	const list = await loadAdminPlatformFeedbackData(
		env,
		'https://example.com/admin/platform-feedback?status=open&category=suggestion',
	)
	expect(list).toMatchObject({
		ok: true,
		total: 1,
		page: 1,
		pageSize: 20,
		content_warning: platformFeedbackContentWarning,
		statusFilter: 'open',
		categoryFilter: 'suggestion',
		selectedFeedback: null,
	})
	expect(list.feedback).toEqual([
		{
			id: 'feedback-missing',
			submitter_user_id: 'stable-deleted',
			category: 'suggestion',
			summary_untrusted: 'Missing submitter account',
			status: 'open',
			reviewed_by_user_id: null,
			reviewed_at: null,
			created_at: '2026-07-19T00:00:00.000Z',
			updated_at: '2026-07-19T00:00:00.000Z',
		},
	])
	expect(list.feedback[0]).not.toHaveProperty('details_untrusted')
	expect(list.feedback[0]).not.toHaveProperty('admin_note')
	expect(list.feedback[0]).not.toHaveProperty('submitter')

	const selected = await loadAdminPlatformFeedbackData(
		env,
		'https://example.com/admin/platform-feedback?feedbackId=feedback-active',
	)
	expect(selected.selectedFeedback).toEqual({
		id: 'feedback-active',
		submitter_user_id: 'stable-active',
		submitter: {
			user_id: 'stable-active',
			username: 'active-submitter',
			email: 'active@example.com',
		},
		category: 'bug',
		summary_untrusted: '<script>summary remains text</script>',
		details_untrusted: 'Full active feedback details.',
		status: 'triaged',
		reviewed_by_user_id: 'stable-reviewer',
		reviewed_at: '2026-07-19T01:30:00.000Z',
		admin_note: 'Follow up with the submitter.',
		created_at: '2026-07-19T01:00:00.000Z',
		updated_at: '2026-07-19T01:30:00.000Z',
	})
	const serializedSelected = JSON.stringify(selected)
	expect(serializedSelected).not.toContain('private_content')
	expect(serializedSelected).not.toContain(
		'ACTIVE_PRIVATE_CONTENT_MUST_NOT_LEAK',
	)
	expect(serializedSelected).not.toContain('other-user')
	expect(serializedSelected).not.toContain('other@example.com')
	expect(serializedSelected).not.toContain('OTHER_USER_CONTENT_MUST_NOT_LEAK')

	const missingIdentity = await loadAdminPlatformFeedbackData(
		env,
		'https://example.com/admin/platform-feedback?feedbackId=feedback-missing',
	)
	expect(missingIdentity.selectedFeedback).toMatchObject({
		id: 'feedback-missing',
		submitter_user_id: 'stable-deleted',
		submitter: null,
	})

	const missingSelection = await loadAdminPlatformFeedbackData(
		env,
		'https://example.com/admin/platform-feedback?feedbackId=',
	)
	expect(missingSelection.selectedFeedback).toBeNull()
	const invalidSelection = await loadAdminPlatformFeedbackData(
		env,
		`https://example.com/admin/platform-feedback?feedbackId=${'x'.repeat(1_001)}`,
	)
	expect(invalidSelection.selectedFeedback).toBeNull()

	sqlite.close()
})
