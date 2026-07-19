import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	getPlatformFeedbackByIdForAdmin,
	updatePlatformFeedbackStatusForAdmin,
} from './repo.ts'
import {
	getPlatformFeedbackForAdmin,
	listPlatformFeedbackForAdmin,
	submitPlatformFeedback,
	updatePlatformFeedbackForAdmin,
} from './service.ts'

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
		async batch(statements: Array<TestD1Statement>) {
			const results = []
			sqlite.exec('BEGIN')
			try {
				for (const statement of statements) {
					results.push(await statement.run())
				}
				sqlite.exec('COMMIT')
				return results
			} catch (error) {
				sqlite.exec('ROLLBACK')
				throw error
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
	const correctedTriage = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-b',
		action: 'triage',
		adminNote: 'Corrected setup-flow note.',
	})
	expect(correctedTriage).toMatchObject({
		status: 'triaged',
		reviewedByUserId: 'admin-b',
		adminNote: 'Corrected setup-flow note.',
	})
	expect(
		await updatePlatformFeedbackForAdmin({
			db,
			feedbackId: first.id,
			reviewerUserId: 'admin-c',
			action: 'triage',
			adminNote: 'Corrected setup-flow note.',
		}),
	).toEqual(correctedTriage)
	const clearedTriage = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-c',
		action: 'triage',
		adminNote: '   ',
	})
	expect(clearedTriage).toMatchObject({
		status: 'triaged',
		reviewedByUserId: 'admin-c',
		adminNote: null,
	})
	const restoredTriage = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-d',
		action: 'triage',
		adminNote: 'Preserve this note when resolving.',
	})
	expect(restoredTriage.adminNote).toBe('Preserve this note when resolving.')

	const resolved = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-e',
		action: 'resolve',
	})
	expect(resolved).toMatchObject({
		status: 'resolved',
		reviewedByUserId: 'admin-e',
		adminNote: 'Preserve this note when resolving.',
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

test('platform feedback admin note updates reject the same stale revision', async () => {
	const { db } = createPlatformFeedbackDb()
	const submitted = await submitPlatformFeedback({
		db,
		submitterUserId: 'user-a',
		category: 'friction',
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
	})
	const stale = await getPlatformFeedbackByIdForAdmin(db, submitted.id)
	expect(stale).not.toBeNull()
	if (!stale) throw new Error('Expected submitted platform feedback.')
	expect(stale.revision).toBe(0)

	const firstUpdate = await updatePlatformFeedbackStatusForAdmin(db, {
		feedbackId: stale.id,
		expectedStatus: stale.status,
		expectedRevision: stale.revision,
		status: stale.status,
		reviewedByUserId: 'admin-a',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		adminNote: 'First competing note.',
	})
	const staleUpdate = await updatePlatformFeedbackStatusForAdmin(db, {
		feedbackId: stale.id,
		expectedStatus: stale.status,
		expectedRevision: stale.revision,
		status: stale.status,
		reviewedByUserId: 'admin-b',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		adminNote: 'Second competing note.',
	})
	expect(firstUpdate).toBe(true)
	expect(staleUpdate).toBe(false)

	const current = await getPlatformFeedbackByIdForAdmin(db, submitted.id)
	expect(current).toMatchObject({
		status: 'open',
		reviewedByUserId: 'admin-a',
		adminNote: 'First competing note.',
		revision: 1,
	})
	const publicRecord = await getPlatformFeedbackForAdmin({
		db,
		feedbackId: submitted.id,
	})
	expect(publicRecord).not.toHaveProperty('revision')
})

test('platform feedback submission enforces the rolling rate limit and atomic active queue cap', async () => {
	const rateLimited = createPlatformFeedbackDb()
	for (let index = 0; index < 10; index += 1) {
		await submitPlatformFeedback({
			db: rateLimited.db,
			submitterUserId: 'rate-limited-user',
			category: 'friction',
			summary: `Feedback ${index}`,
			details: `Feedback details ${index}`,
		})
	}
	await expect(
		submitPlatformFeedback({
			db: rateLimited.db,
			submitterUserId: 'rate-limited-user',
			category: 'friction',
			summary: 'Feedback 11',
			details: 'This submission exceeds the rolling limit.',
		}),
	).rejects.toThrow(
		'Platform feedback is limited to 10 submissions per rolling 24 hours. Retry after 86400 seconds.',
	)
	expect(
		rateLimited.sqlite
			.prepare(`SELECT COUNT(*) AS total FROM platform_feedback`)
			.get(),
	).toEqual({ total: 10 })

	const queueLimited = createPlatformFeedbackDb()
	const insertQueued = queueLimited.sqlite.prepare(
		`INSERT INTO platform_feedback (
			id, submitter_user_id, category, summary, details, status,
			created_at, updated_at
		) VALUES (?, 'queue-limited-user', 'friction', ?, ?, ?, ?, ?)`,
	)
	const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString()
	for (let index = 0; index < 99; index += 1) {
		insertQueued.run(
			`queued-${index}`,
			`Queued feedback ${index}`,
			`Queued feedback details ${index}`,
			index % 2 === 0 ? 'open' : 'triaged',
			createdAt,
			createdAt,
		)
	}
	await submitPlatformFeedback({
		db: queueLimited.db,
		submitterUserId: 'queue-limited-user',
		category: 'bug',
		summary: 'One hundredth active submission',
		details: 'This reaches the active queue boundary.',
	})
	await expect(
		submitPlatformFeedback({
			db: queueLimited.db,
			submitterUserId: 'queue-limited-user',
			category: 'bug',
			summary: 'One over the active queue boundary',
			details: 'This must be rejected atomically.',
		}),
	).rejects.toThrow(
		'You already have 100 open or triaged platform feedback submissions.',
	)
	queueLimited.sqlite
		.prepare(
			`UPDATE platform_feedback
			SET status = 'resolved', updated_at = ?
			WHERE id = 'queued-0'`,
		)
		.run(createdAt)
	await submitPlatformFeedback({
		db: queueLimited.db,
		submitterUserId: 'queue-limited-user',
		category: 'bug',
		summary: 'Replacement active submission',
		details: 'A resolved active row makes room for this submission.',
	})
	expect(
		queueLimited.sqlite
			.prepare(
				`SELECT COUNT(*) AS total
				FROM platform_feedback
				WHERE submitter_user_id = 'queue-limited-user'
					AND status IN ('open', 'triaged')`,
			)
			.get(),
	).toEqual({ total: 100 })
})

test('platform feedback rolling rate limit retries when the oldest submission expires', async () => {
	vi.useFakeTimers()
	try {
		const now = new Date('2026-07-19T12:00:00.000Z')
		vi.setSystemTime(now)
		const { sqlite, db } = createPlatformFeedbackDb()
		const createdAt = new Date(
			now.getTime() - 23 * 60 * 60 * 1_000,
		).toISOString()
		const insertFeedback = sqlite.prepare(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, category, summary, details, created_at, updated_at
			) VALUES (?, 'rate-limited-user', 'friction', ?, ?, ?, ?)`,
		)
		for (let index = 0; index < 10; index += 1) {
			insertFeedback.run(
				`feedback-${index}`,
				`Feedback ${index}`,
				`Feedback details ${index}`,
				createdAt,
				createdAt,
			)
		}

		await expect(
			submitPlatformFeedback({
				db,
				submitterUserId: 'rate-limited-user',
				category: 'friction',
				summary: 'Feedback 11',
				details: 'This submission exceeds the rolling limit.',
			}),
		).rejects.toThrow(
			'Platform feedback is limited to 10 submissions per rolling 24 hours. Retry after 3600 seconds.',
		)
	} finally {
		vi.useRealTimers()
	}
})
