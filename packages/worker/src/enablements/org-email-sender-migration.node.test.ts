import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function applyMigrationFile(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((entry) => entry.endsWith('.sql'))
		.sort()) {
		if (name >= fileName) continue
		applyMigrationFile(db, name)
	}
}

function insertEnablement(
	db: DatabaseSync,
	input: {
		id: string
		orgId: string
		triggerKind: string
		triggerName: string
		state: string
	},
) {
	db.prepare(
		`INSERT INTO enablements (
			id, org_id, package_id, trigger_kind, trigger_name, instance_id,
			enabler_user_id, state, origin, enabled_at, updated_at
		) VALUES (?, ?, 'pkg', ?, ?, 'pkg', 'person', ?, 'enabled', ?, ?)`,
	).run(
		input.id,
		input.orgId,
		input.triggerKind,
		input.triggerName,
		input.state,
		'2026-10-13T00:00:00.000Z',
		'2026-10-13T00:00:00.000Z',
	)
}

test('0138 tags live personal-org email subscriptions and leaves team orgs alone', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, '0138-org-email-sender-enablements.sql')
	db.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, deleted_at
		) VALUES (?, ?, 'hash', ?, ?)`,
	).run('ada', 'ada@example.com', 'person-ada', null)
	db.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, deleted_at
		) VALUES (?, ?, 'hash', ?, ?)`,
	).run('gone', 'gone@example.com', 'person-gone', '2026-10-01T00:00:00.000Z')

	insertEnablement(db, {
		id: 'personal-received',
		orgId: 'person-ada',
		triggerKind: 'subscription',
		triggerName: 'email.message.received',
		state: 'on',
	})
	insertEnablement(db, {
		id: 'personal-received-later',
		orgId: 'person-ada',
		triggerKind: 'subscription',
		triggerName: 'email.message.received',
		state: 'on',
	})
	insertEnablement(db, {
		id: 'personal-quarantined',
		orgId: 'person-ada',
		triggerKind: 'subscription',
		triggerName: 'email.message.quarantined',
		state: 'paused',
	})
	insertEnablement(db, {
		id: 'personal-off',
		orgId: 'person-ada',
		triggerKind: 'subscription',
		triggerName: 'email.message.received',
		state: 'off',
	})
	insertEnablement(db, {
		id: 'personal-other-topic',
		orgId: 'person-ada',
		triggerKind: 'subscription',
		triggerName: 'package.published',
		state: 'on',
	})
	insertEnablement(db, {
		id: 'personal-cron',
		orgId: 'person-ada',
		triggerKind: 'cron',
		triggerName: 'email.message.received',
		state: 'on',
	})
	insertEnablement(db, {
		id: 'team-received',
		orgId: 'team-org',
		triggerKind: 'subscription',
		triggerName: 'email.message.received',
		state: 'on',
	})
	insertEnablement(db, {
		id: 'deleted-person',
		orgId: 'person-gone',
		triggerKind: 'subscription',
		triggerName: 'email.message.received',
		state: 'on',
	})

	applyMigrationFile(db, '0138-org-email-sender-enablements.sql')

	const rows = db
		.prepare(
			`SELECT id, sender_kind, sender_value FROM enablements ORDER BY id`,
		)
		.all() as Array<{
		id: string
		sender_kind: string | null
		sender_value: string | null
	}>
	expect(rows).toEqual([
		{
			id: 'deleted-person',
			sender_kind: null,
			sender_value: null,
		},
		{
			id: 'personal-cron',
			sender_kind: null,
			sender_value: null,
		},
		{
			id: 'personal-off',
			sender_kind: null,
			sender_value: null,
		},
		{
			id: 'personal-other-topic',
			sender_kind: null,
			sender_value: null,
		},
		{
			id: 'personal-quarantined',
			sender_kind: 'any_authenticated',
			sender_value: null,
		},
		{
			id: 'personal-received',
			sender_kind: 'any_authenticated',
			sender_value: null,
		},
		{
			id: 'personal-received-later',
			sender_kind: null,
			sender_value: null,
		},
		{
			id: 'team-received',
			sender_kind: null,
			sender_value: null,
		},
	])
})

test('0138 prefers an on row over an older paused sibling for the catch-all', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, '0138-org-email-sender-enablements.sql')
	db.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, deleted_at
		) VALUES (?, ?, 'hash', ?, ?)`,
	).run('bea', 'bea@example.com', 'person-bea', null)
	db.prepare(
		`INSERT INTO enablements (
			id, org_id, package_id, trigger_kind, trigger_name, instance_id,
			enabler_user_id, state, origin, enabled_at, updated_at
		) VALUES (?, ?, 'pkg', 'subscription', 'email.message.received', 'pkg',
			'person', ?, 'enabled', ?, ?)`,
	).run(
		'paused-earlier',
		'person-bea',
		'paused',
		'2026-10-01T00:00:00.000Z',
		'2026-10-01T00:00:00.000Z',
	)
	db.prepare(
		`INSERT INTO enablements (
			id, org_id, package_id, trigger_kind, trigger_name, instance_id,
			enabler_user_id, state, origin, enabled_at, updated_at
		) VALUES (?, ?, 'pkg', 'subscription', 'email.message.received', 'pkg',
			'person', ?, 'enabled', ?, ?)`,
	).run(
		'on-later',
		'person-bea',
		'on',
		'2026-10-13T00:00:00.000Z',
		'2026-10-13T00:00:00.000Z',
	)
	applyMigrationFile(db, '0138-org-email-sender-enablements.sql')
	const rows = db
		.prepare(
			`SELECT id, sender_kind FROM enablements WHERE org_id = 'person-bea' ORDER BY id`,
		)
		.all() as Array<{ id: string; sender_kind: string | null }>
	expect(rows).toEqual([
		{ id: 'on-later', sender_kind: 'any_authenticated' },
		{ id: 'paused-earlier', sender_kind: null },
	])
})

test('0138 allows one live email sender rule per org, instance, topic, and sender', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, '0138-org-email-sender-enablements.sql')
	applyMigrationFile(db, '0138-org-email-sender-enablements.sql')
	const insert = (
		id: string,
		senderValue: string,
		enabler: string,
		triggerName = 'email.message.received',
	) => {
		db.prepare(
			`INSERT INTO enablements (
				id, org_id, package_id, trigger_kind, trigger_name, instance_id,
				enabler_user_id, state, origin, sender_kind, sender_value,
				enabled_at, updated_at
			) VALUES (?, 'org', 'pkg', 'subscription', ?, 'pkg',
				?, 'on', 'enabled', 'address', ?, ?, ?)`,
		).run(
			id,
			triggerName,
			enabler,
			senderValue,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
	}
	insert('one', 'receipts@shop.example', 'person-a')
	expect(() => insert('two', 'receipts@shop.example', 'person-b')).toThrow(
		/enablements_email_sender_one_live|UNIQUE constraint failed/i,
	)
	insert('other-sender', 'other@shop.example', 'person-a')
	insert(
		'other-topic',
		'receipts@shop.example',
		'person-a',
		'email.message.quarantined',
	)
	db.prepare(`UPDATE enablements SET state = 'off' WHERE id = 'one'`).run()
	insert('after-off', 'receipts@shop.example', 'person-b')
})
