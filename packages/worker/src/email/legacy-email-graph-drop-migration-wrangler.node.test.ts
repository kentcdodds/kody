import { spawnSync } from 'node:child_process'
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { getAccountD1UserColumnCoverage } from '#worker/account/data-targets.ts'
import { migrationsDirectory } from '#worker/test-support/system-email-graph-migration.ts'

const dropMigration = '0134-drop-legacy-email-graph.sql'
const workspaceDirectory = fileURLToPath(
	new URL('../../../../', import.meta.url),
)
const wranglerCli = join(
	workspaceDirectory,
	'node_modules/wrangler/bin/wrangler.js',
)

function createTemporaryDirectory() {
	const path = mkdtempSync(join(tmpdir(), 'kody-email-graph-drop-'))
	return {
		path,
		[Symbol.dispose]() {
			rmSync(path, { force: true, recursive: true })
		},
	}
}

function runWrangler(
	workingDirectory: string,
	...arguments_: ReadonlyArray<string>
) {
	const result = spawnSync(process.execPath, [wranglerCli, ...arguments_], {
		cwd: workingDirectory,
		encoding: 'utf8',
		env: {
			...process.env,
			CI: '1',
			NO_COLOR: '1',
			WRANGLER_SEND_METRICS: 'false',
		},
		maxBuffer: 16 * 1024 * 1024,
		timeout: 60_000,
	})
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		...(result.error ? { error: result.error } : {}),
	}
}

function expectWranglerSuccess(result: ReturnType<typeof runWrangler>) {
	expect(result.error).toBeUndefined()
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

function executeSql(input: {
	workingDirectory: string
	configPath: string
	statePath: string
	sql: string
}) {
	const result = runWrangler(
		input.workingDirectory,
		'd1',
		'execute',
		'APP_DB',
		'--local',
		'--config',
		input.configPath,
		'--persist-to',
		input.statePath,
		'--command',
		input.sql,
	)
	expectWranglerSuccess(result)
}

function sqliteFiles(path: string): Array<string> {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(path, entry.name)
		if (entry.isDirectory()) return sqliteFiles(entryPath)
		return entry.isFile() &&
			entry.name.endsWith('.sqlite') &&
			entry.name !== 'metadata.sqlite'
			? [entryPath]
			: []
	})
}

function openDatabase(statePath: string) {
	const files = sqliteFiles(statePath)
	expect(files).toHaveLength(1)
	return new DatabaseSync(files[0]!)
}

const approvalTableSql = `
	CREATE TABLE email_user_graph_drop_approval (
		singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
		authority_frozen_at TEXT NOT NULL,
		backup_object_key TEXT NOT NULL,
		backup_sha256 TEXT NOT NULL,
		verified_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
		thread_count INTEGER NOT NULL CHECK (thread_count >= 0),
		message_count INTEGER NOT NULL CHECK (message_count >= 0),
		attachment_count INTEGER NOT NULL CHECK (attachment_count >= 0),
		delivery_event_count INTEGER NOT NULL CHECK (delivery_event_count >= 0)
	);`

function approvalInsert(input: {
	expiresAt: string
	threadCount: number
	sha256?: string
	objectKey?: string
}) {
	return `INSERT INTO email_user_graph_drop_approval (
		singleton, authority_frozen_at, backup_object_key, backup_sha256,
		verified_at, expires_at, owner_count, thread_count, message_count,
		attachment_count, delivery_event_count
	) VALUES (
		1, '2026-08-03T14:53:49Z',
		'${input.objectKey ?? 'd1/production/verified-backup.sql.gz'}',
		'${input.sha256 ?? 'a'.repeat(64)}',
		'2026-08-03T14:55:00Z', '${input.expiresAt}',
		1, ${input.threadCount}, 1, 1, 1
	);`
}

test(
	'0134 fails closed and drops only the approved legacy graph through Wrangler',
	{ timeout: 360_000 },
	() => {
		using temporary = createTemporaryDirectory()
		const migrationPath = join(temporary.path, 'migrations')
		const statePath = join(temporary.path, 'state')
		const configPath = join(temporary.path, 'wrangler.json')
		mkdirSync(migrationPath)
		writeFileSync(
			join(temporary.path, 'worker.js'),
			'export default { fetch: () => new Response("ok") }\n',
		)
		writeFileSync(
			configPath,
			JSON.stringify({
				name: 'email-graph-drop-test',
				compatibility_date: '2026-04-16',
				main: './worker.js',
				d1_databases: [
					{
						binding: 'APP_DB',
						database_name: 'email-graph-drop-test',
						database_id: '00000000-0000-0000-0000-000000000000',
						migrations_dir: './migrations',
					},
				],
			}),
		)
		for (const fileName of readdirSync(migrationsDirectory)
			.filter(
				(fileName) => fileName.endsWith('.sql') && fileName < dropMigration,
			)
			.sort()) {
			copyFileSync(
				new URL(fileName, migrationsDirectory),
				join(migrationPath, fileName),
			)
		}

		const applyArguments = [
			'd1',
			'migrations',
			'apply',
			'APP_DB',
			'--local',
			'--config',
			configPath,
			'--persist-to',
			statePath,
		]
		expectWranglerSuccess(runWrangler(temporary.path, ...applyArguments))
		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `
				INSERT INTO users (
					username, email, password_hash, stable_user_id, display_name
				) VALUES (
					'graph-owner', 'graph-owner@example.test', 'hash', 'user-1',
					'Preserved User'
				);
				UPDATE email_user_graph_authority
				SET owner_count = 1, frozen_at = '2026-08-03T14:53:49Z'
				WHERE singleton = 1;
				INSERT INTO email_inboxes (
					id, user_id, name, description, enabled, created_at, updated_at
				) VALUES (
					'preserved-inbox', 'user-1', 'main', 'Preserved config', 1,
					CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				);
				INSERT INTO email_sender_identities (
					id, user_id, email, status, created_at, updated_at
				) VALUES (
					'preserved-sender', 'user-1', 'owner@example.test', 'verified',
					CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				);
				INSERT INTO email_threads (
					id, user_id, last_message_at, created_at, updated_at
				) VALUES
					('user-thread', 'user-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
						CURRENT_TIMESTAMP),
					('system-thread', 'system:email', CURRENT_TIMESTAMP,
						CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
				INSERT INTO system_email_threads (
					id, last_message_at, created_at, updated_at
				) SELECT id, last_message_at, created_at, updated_at
				FROM email_threads WHERE id = 'system-thread';
				INSERT INTO email_messages (
					id, direction, user_id, thread_id, from_address,
					processing_status, created_at, updated_at
				) VALUES
					('user-message', 'inbound', 'user-1', 'user-thread',
						'sender@example.test', 'stored', CURRENT_TIMESTAMP,
						CURRENT_TIMESTAMP),
					('system-message', 'inbound', 'system:email', 'system-thread',
						'sender@example.test', 'stored', CURRENT_TIMESTAMP,
						CURRENT_TIMESTAMP);
				INSERT INTO system_email_messages (
					id, direction, thread_id, from_address, processing_status,
					created_at, updated_at
				) SELECT
					id, direction, thread_id, from_address, processing_status,
					created_at, updated_at
				FROM email_messages WHERE id = 'system-message';
				INSERT INTO email_attachments (
					id, message_id, content_type, storage_kind, created_at
				) VALUES
					('user-attachment', 'user-message', 'text/plain', 'raw-mime',
						CURRENT_TIMESTAMP),
					('system-attachment', 'system-message', 'text/plain', 'raw-mime',
						CURRENT_TIMESTAMP);
				INSERT INTO system_email_attachments (
					id, message_id, content_type, storage_kind, created_at
				) SELECT id, message_id, content_type, storage_kind, created_at
				FROM email_attachments WHERE id = 'system-attachment';
				INSERT INTO email_delivery_events (
					id, message_id, user_id, event_type, created_at, updated_at
				) VALUES
					('user-event', 'user-message', 'user-1', 'received',
						CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
					('system-event', 'system-message', 'system:email', 'received',
						CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
				INSERT INTO system_email_delivery_events (
					id, message_id, event_type, created_at, updated_at
				) SELECT id, message_id, event_type, created_at, updated_at
				FROM email_delivery_events WHERE id = 'system-event';
				INSERT INTO email_outbound_provider_index (
					provider, provider_message_id, user_id, message_id, inbox_id,
					created_at, updated_at
				) VALUES (
					'cloudflare', 'provider-user-message', 'user-1', 'user-message',
					'preserved-inbox', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				);
				INSERT INTO email_inbound_due_owners (
					user_id, due_at, reason, updated_at
				) VALUES (
					'user-live-hint', '2099-01-01T00:00:00Z', 'live',
					CURRENT_TIMESTAMP
				);
				INSERT INTO email_delivery_alert_events (
					provider_event_id, provider, event_type, occurred_at, created_at
				) VALUES (
					'provider-event', 'cloudflare', 'bounced', CURRENT_TIMESTAMP,
					CURRENT_TIMESTAMP
				);`,
		})
		copyFileSync(
			new URL(dropMigration, migrationsDirectory),
			join(migrationPath, dropMigration),
		)

		const absent = runWrangler(temporary.path, ...applyArguments)
		expect(absent.status).not.toBe(0)
		expect(`${absent.stdout}\n${absent.stderr}`).toContain(
			'email_user_graph_drop_approval',
		)

		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `${approvalTableSql}${approvalInsert({
				expiresAt: '2026-08-03T14:54:00Z',
				threadCount: 1,
			})}`,
		})
		const expired = runWrangler(temporary.path, ...applyArguments)
		expect(expired.status).not.toBe(0)
		expect(`${expired.stdout}\n${expired.stderr}`).toContain(
			'CHECK constraint failed',
		)

		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `DELETE FROM email_user_graph_drop_approval;
				${approvalInsert({
					expiresAt: '2099-01-01T00:00:00Z',
					threadCount: 2,
				})}`,
		})
		const wrongCount = runWrangler(temporary.path, ...applyArguments)
		expect(wrongCount.status).not.toBe(0)

		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `DELETE FROM email_user_graph_drop_approval;
				${approvalInsert({
					expiresAt: '2099-01-01T00:00:00Z',
					threadCount: 1,
					sha256: 'not-a-sha',
				})}`,
		})
		const wrongHash = runWrangler(temporary.path, ...applyArguments)
		expect(wrongHash.status).not.toBe(0)

		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `DELETE FROM email_user_graph_drop_approval;
				${approvalInsert({
					expiresAt: '2099-01-01T00:00:00Z',
					threadCount: 1,
					objectKey: '',
				})}`,
		})
		const emptyObjectKey = runWrangler(temporary.path, ...applyArguments)
		expect(emptyObjectKey.status).not.toBe(0)

		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `UPDATE system_email_threads
				SET subject_normalized = 'dedicated-drift'
				WHERE id = 'system-thread';`,
		})
		const systemDrift = runWrangler(temporary.path, ...applyArguments)
		expect(systemDrift.status).not.toBe(0)
		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `UPDATE system_email_threads
				SET subject_normalized = ''
				WHERE id = 'system-thread';`,
		})

		let expectedUserColumns: Array<Record<string, unknown>>
		let expectedUserForeignKeys: Array<Record<string, unknown>>
		let expectedUserIndexes: Array<Record<string, unknown>>
		using before = openDatabase(statePath)
		expectedUserColumns = before
			.prepare(`PRAGMA table_info('users')`)
			.all()
			.filter(
				(column) =>
					!String((column as { name: unknown }).name).startsWith(
						'mailbox_parity_',
					),
			)
		expectedUserForeignKeys = before
			.prepare(`PRAGMA foreign_key_list('users')`)
			.all()
		expectedUserIndexes = before
			.prepare(`PRAGMA index_list('users')`)
			.all()
			.filter(
				(index) =>
					(index as { name: unknown }).name !==
					'idx_users_mailbox_parity_checked',
			)
			.map(({ seq: _sequence, ...index }) => index)
		expect(
			before
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM email_messages) AS messages,
						(SELECT COUNT(*) FROM d1_migrations WHERE name = ?) AS ledger,
						(SELECT COUNT(*) FROM pragma_table_info('users')
							WHERE name LIKE 'mailbox_parity_%') AS parity_columns`,
				)
				.get(dropMigration),
		).toEqual({ messages: 2, ledger: 0, parity_columns: 14 })
		before.close()

		executeSql({
			workingDirectory: temporary.path,
			configPath,
			statePath,
			sql: `DELETE FROM email_user_graph_drop_approval;
				${approvalInsert({
					expiresAt: '2099-01-01T00:00:00Z',
					threadCount: 1,
				})}`,
		})
		expectWranglerSuccess(runWrangler(temporary.path, ...applyArguments))

		using after = openDatabase(statePath)
		const tables = after
			.prepare(
				`SELECT name FROM sqlite_schema
				WHERE type = 'table' AND name IN (
					'email_threads', 'email_messages', 'email_attachments',
					'email_delivery_events', 'email_inbound_usage_effects',
					'email_user_graph_drop_approval'
				)`,
			)
			.all()
		expect(tables).toEqual([])
		const parityColumns = after
			.prepare(
				`SELECT name FROM pragma_table_info('users')
				WHERE name LIKE 'mailbox_parity_%'`,
			)
			.all()
		expect(parityColumns).toEqual([])
		expect(
			after
				.prepare(
					`SELECT
						(SELECT display_name FROM users
							WHERE stable_user_id = 'user-1') AS display_name,
						(SELECT COUNT(*) FROM email_inboxes
							WHERE id = 'preserved-inbox') AS inboxes,
						(SELECT COUNT(*) FROM email_sender_identities
							WHERE id = 'preserved-sender') AS senders,
						(SELECT COUNT(*) FROM email_outbound_provider_index
							WHERE provider_message_id = 'provider-user-message')
							AS provider_links,
						(SELECT COUNT(*) FROM system_email_threads) AS system_threads,
						(SELECT COUNT(*) FROM system_email_messages) AS system_messages,
						(SELECT COUNT(*) FROM system_email_attachments)
							AS system_attachments,
						(SELECT COUNT(*) FROM system_email_delivery_events)
							AS system_events,
						(SELECT COUNT(*) FROM email_inbound_due_owners
							WHERE user_id = 'user-live-hint') AS due_hints,
						(SELECT COUNT(*) FROM email_delivery_alert_events) AS alerts,
						(SELECT COUNT(*) FROM d1_migrations WHERE name = ?) AS ledger,
						(SELECT owner_count FROM email_user_graph_authority
							WHERE singleton = 1) AS owners,
						(SELECT frozen_at FROM email_user_graph_authority
							WHERE singleton = 1) AS frozen_at,
						(SELECT backup_object_key FROM email_user_graph_authority
							WHERE singleton = 1) AS backup_object_key,
						(SELECT backup_sha256 FROM email_user_graph_authority
							WHERE singleton = 1) AS backup_sha256,
						(SELECT dropped_at FROM email_user_graph_authority
							WHERE singleton = 1) AS dropped_at`,
				)
				.get(dropMigration),
		).toEqual({
			display_name: 'Preserved User',
			inboxes: 1,
			senders: 1,
			provider_links: 1,
			system_threads: 1,
			system_messages: 1,
			system_attachments: 1,
			system_events: 1,
			due_hints: 1,
			alerts: 1,
			ledger: 1,
			owners: 1,
			frozen_at: '2026-08-03T14:53:49Z',
			backup_object_key: 'd1/production/verified-backup.sql.gz',
			backup_sha256: 'a'.repeat(64),
			dropped_at: expect.any(String),
		})
		expect(after.prepare(`PRAGMA table_info('users')`).all()).toEqual(
			expectedUserColumns,
		)
		expect(after.prepare(`PRAGMA foreign_key_list('users')`).all()).toEqual(
			expectedUserForeignKeys,
		)
		expect(
			after
				.prepare(`PRAGMA index_list('users')`)
				.all()
				.map(({ seq: _sequence, ...index }) => index),
		).toEqual(expectedUserIndexes)
		const coveredColumns = getAccountD1UserColumnCoverage()
		const staleCoveredColumns = [...coveredColumns].filter((entry) => {
			const [table, column] = entry.split('.')
			if (!table || !column) return true
			return !after
				.prepare(
					`SELECT 1 AS present FROM pragma_table_info(?)
					WHERE name = ?`,
				)
				.get(table, column)
		})
		expect(staleCoveredColumns).toEqual([])
		expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([])
	},
)
