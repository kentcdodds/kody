import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import {
	loadOrgBillingRecipientEmails,
	sendToOrgBillingRecipients,
} from './org-billing-emails.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				stable_user_id TEXT NOT NULL UNIQUE,
				email TEXT NOT NULL,
				username TEXT NOT NULL,
				deleting_at TEXT
			)`,
		)
		.run()
	return db
}

const now = '2026-01-02T00:00:00.000Z'

async function seedUser(
	db: D1Database,
	input: { userId: string; email: string; deletingAt?: string | null },
) {
	await db
		.prepare(
			`INSERT INTO users (stable_user_id, email, username, deleting_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(
			input.userId,
			input.email,
			input.email.split('@')[0] ?? 'user',
			input.deletingAt ?? null,
		)
		.run()
}

test('loadOrgBillingRecipientEmails joins owners and billing members to email', async () => {
	const db = await createDb()
	const orgId = 'org-mail'
	const owner = testStableUserIdFromEmail('owner@example.com')
	const billing = testStableUserIdFromEmail('billing@example.com')
	const member = testStableUserIdFromEmail('member@example.com')
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, ?, 'pro', ?, ?)`,
		)
		.bind(orgId, 'mail-org', now, now)
		.run()
	for (const [userId, role] of [
		[owner, 'owner'],
		[billing, 'billing'],
		[member, 'member'],
	] as const) {
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(orgId, userId, role, now)
			.run()
	}
	await seedUser(db, { userId: owner, email: 'owner@example.com' })
	await seedUser(db, { userId: billing, email: 'billing@example.com' })
	await seedUser(db, { userId: member, email: 'member@example.com' })

	const recipients = await loadOrgBillingRecipientEmails(db, orgId)
	expect(recipients.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
		[
			{ userId: billing, email: 'billing@example.com' },
			{ userId: owner, email: 'owner@example.com' },
		].sort((a, b) => a.userId.localeCompare(b.userId)),
	)
})

test('sendToOrgBillingRecipients fans out and throws when no recipients', async () => {
	const db = await createDb()
	const orgId = 'org-empty'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, ?, 'pro', ?, ?)`,
		)
		.bind(orgId, 'empty', now, now)
		.run()

	await expect(
		sendToOrgBillingRecipients({
			db,
			orgId,
			sendOne: async () => {},
		}),
	).rejects.toThrow(/No billing recipients/)

	const owner = testStableUserIdFromEmail('fanout@example.com')
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(orgId, owner, now)
		.run()
	await seedUser(db, { userId: owner, email: 'fanout@example.com' })

	const sent: Array<string> = []
	const count = await sendToOrgBillingRecipients({
		db,
		orgId,
		sendOne: async (recipient) => {
			sent.push(recipient.email)
		},
	})
	expect(count).toBe(1)
	expect(sent).toEqual(['fanout@example.com'])
})
