import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	getPlatformFeedbackForAdmin,
	listPlatformFeedbackForAdmin,
	submitPlatformFeedback,
	updatePlatformFeedbackForAdmin,
} from './service.ts'

function createD1FromSqlite(sqlite: DatabaseSync) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
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
				},
			}
		},
	} as unknown as D1Database
}

function createPlatformFeedbackDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL('../../migrations/0062-platform-feedback.sql', import.meta.url),
			'utf8',
		),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('platform feedback workflow submits, lists, reads, transitions, and preserves submitter attribution', async () => {
	const { sqlite, db } = createPlatformFeedbackDb()
	const first = await submitPlatformFeedback({
		db,
		submitterUserId: 'user-a',
		category: 'friction',
		summary: '  Setup is confusing  ',
		details: '  The setup flow does not explain the next action.  ',
	})
	const second = await submitPlatformFeedback({
		db,
		submitterUserId: 'user-b',
		category: 'bug',
		summary: 'Button does not save',
		details: 'The save button leaves the form unchanged.',
	})
	const third = await submitPlatformFeedback({
		db,
		submitterUserId: 'user-a',
		category: 'experience',
		summary: 'Search feels slow',
		details: 'Search takes several seconds to show the first result.',
	})

	expect(first).toMatchObject({
		submitterUserId: 'user-a',
		category: 'friction',
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
		status: 'open',
	})
	expect(second.submitterUserId).toBe('user-b')
	expect(third.submitterUserId).toBe('user-a')

	const page = await listPlatformFeedbackForAdmin({
		db,
		page: 1,
		pageSize: 2,
	})
	expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 })
	expect(page.items).toHaveLength(2)
	for (const item of page.items) {
		expect(Object.keys(item).sort()).toEqual(
			[
				'category',
				'createdAt',
				'id',
				'reviewedAt',
				'reviewedByUserId',
				'status',
				'submitterUserId',
				'summary',
				'updatedAt',
			].sort(),
		)
	}
	const bugFeedback = await listPlatformFeedbackForAdmin({
		db,
		status: 'open',
		category: 'bug',
	})
	expect(bugFeedback).toMatchObject({ page: 1, pageSize: 20, total: 1 })
	expect(bugFeedback.items).toEqual([
		expect.objectContaining({
			id: second.id,
			submitterUserId: 'user-b',
		}),
	])

	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: second.id }),
	).toMatchObject({
		id: second.id,
		details: 'The save button leaves the form unchanged.',
		adminNote: null,
	})

	const triaged = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-a',
		action: 'triage',
		adminNote: 'Needs setup-flow review.',
	})
	expect(triaged).toMatchObject({
		status: 'triaged',
		reviewedByUserId: 'admin-a',
		adminNote: 'Needs setup-flow review.',
	})
	expect(
		await updatePlatformFeedbackForAdmin({
			db,
			feedbackId: first.id,
			reviewerUserId: 'admin-b',
			action: 'triage',
			adminNote: 'This idempotent retry must not replace the first review.',
		}),
	).toEqual(triaged)

	const resolved = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-b',
		action: 'resolve',
		adminNote: 'Setup guidance was added.',
	})
	expect(resolved).toMatchObject({
		status: 'resolved',
		reviewedByUserId: 'admin-b',
		adminNote: 'Setup guidance was added.',
	})
	expect(
		await updatePlatformFeedbackForAdmin({
			db,
			feedbackId: first.id,
			reviewerUserId: 'admin-c',
			action: 'resolve',
		}),
	).toEqual(resolved)
	await expect(
		updatePlatformFeedbackForAdmin({
			db,
			feedbackId: first.id,
			reviewerUserId: 'admin-c',
			action: 'dismiss',
		}),
	).rejects.toThrow(
		`Cannot dismiss platform feedback "${first.id}" from status "resolved".`,
	)
	await expect(
		updatePlatformFeedbackForAdmin({
			db,
			feedbackId: 'missing-feedback',
			reviewerUserId: 'admin-a',
			action: 'triage',
		}),
	).rejects.toThrow('Platform feedback "missing-feedback" was not found.')

	const rows = sqlite
		.prepare(
			`SELECT id, submitter_user_id FROM platform_feedback ORDER BY submitter_user_id, id`,
		)
		.all() as Array<{ id: string; submitter_user_id: string }>
	expect(rows.filter((row) => row.submitter_user_id === 'user-a')).toHaveLength(
		2,
	)
	expect(rows.filter((row) => row.submitter_user_id === 'user-b')).toEqual([
		{ id: second.id, submitter_user_id: 'user-b' },
	])
})
