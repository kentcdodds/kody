import { spawnSync } from 'node:child_process'
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { unstable_splitSqlQuery } from 'wrangler'
import {
	migrationsDirectory,
	systemEmailAuthorityMigration,
} from '#worker/test-support/system-email-graph-migration.ts'

const workspaceDirectory = fileURLToPath(
	new URL('../../../../', import.meta.url),
)
const wranglerCli = join(
	workspaceDirectory,
	'node_modules/wrangler/bin/wrangler.js',
)
const maxWranglerOutputBytes = 16 * 1024 * 1024
const d1CompoundSelectTermLimit = 5

type WranglerResult = {
	status: number | null
	stdout: string
	stderr: string
	error?: Error
}

function createTemporaryDirectory() {
	const path = mkdtempSync(join(tmpdir(), 'kody-system-email-migration-'))
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
): WranglerResult {
	const result = spawnSync(process.execPath, [wranglerCli, ...arguments_], {
		cwd: workingDirectory,
		encoding: 'utf8',
		env: {
			...process.env,
			CI: '1',
			NO_COLOR: '1',
			WRANGLER_SEND_METRICS: 'false',
		},
		maxBuffer: maxWranglerOutputBytes,
		timeout: 60_000,
	})
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		...(result.error ? { error: result.error } : {}),
	}
}

function expectWranglerSuccess(result: WranglerResult) {
	expect(result.error).toBeUndefined()
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

function executeSql(
	workingDirectory: string,
	configPath: string,
	statePath: string,
	sql: string,
) {
	const result = runWrangler(
		workingDirectory,
		'd1',
		'execute',
		'APP_DB',
		'--local',
		'--config',
		configPath,
		'--persist-to',
		statePath,
		'--command',
		sql,
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

function readDatabaseRow(statePath: string, sql: string) {
	const files = sqliteFiles(statePath)
	expect(files).toHaveLength(1)
	using db = new DatabaseSync(files[0]!)
	return db.prepare(sql).get()
}

function compoundSelectTermCount(sql: string) {
	return 1 + (sql.match(/\bUNION(?:\s+ALL)?\b/giu)?.length ?? 0)
}

test('0131 keeps every D1 guard bounded and orders cutover after all checks', () => {
	const sql = readFileSync(
		new URL(systemEmailAuthorityMigration, migrationsDirectory),
		'utf8',
	)
	const statements = unstable_splitSqlQuery(sql)
	const checkIndexes = statements
		.map((statement, index) =>
			statement.startsWith('INSERT INTO system_email_graph_migration_checks')
				? index
				: -1,
		)
		.filter((index) => index >= 0)
	const firstGraphMutationIndex = statements.findIndex((statement) =>
		statement.startsWith('DELETE FROM system_email_delivery_events'),
	)
	const finalNormalizationIndex = statements.findLastIndex((statement) =>
		statement.startsWith('UPDATE email_delivery_events'),
	)
	const markerIndex = statements.findIndex((statement) =>
		statement.startsWith('INSERT INTO system_email_graph_authority'),
	)
	const dropChecksIndex = statements.findIndex((statement) =>
		statement.startsWith('DROP TABLE system_email_graph_migration_checks'),
	)
	expect(firstGraphMutationIndex).toBeGreaterThanOrEqual(0)
	expect(finalNormalizationIndex).toBeGreaterThanOrEqual(0)
	expect(markerIndex).toBeGreaterThanOrEqual(0)
	expect(dropChecksIndex).toBeGreaterThanOrEqual(0)

	expect(
		Math.max(...statements.map(compoundSelectTermCount)),
		`D1 accepts at most ${d1CompoundSelectTermLimit} compound SELECT terms`,
	).toBeLessThanOrEqual(d1CompoundSelectTermLimit)
	expect(checkIndexes).toHaveLength(10)
	expect(
		checkIndexes.map((index) => compoundSelectTermCount(statements[index]!)),
	).toEqual(Array.from({ length: 10 }, () => 1))
	expect(
		checkIndexes.slice(0, 6).every((index) => index < firstGraphMutationIndex),
	).toBe(true)
	expect(
		checkIndexes
			.slice(6)
			.every((index) => index > finalNormalizationIndex && index < markerIndex),
	).toBe(true)
	expect(markerIndex).toBeGreaterThan(Math.max(...checkIndexes))
	expect(dropChecksIndex).toBe(markerIndex + 1)
})

test(
	'0131 uses Wrangler D1 atomic rollback, then applies after preflight repair',
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
				name: 'system-email-migration-test',
				compatibility_date: '2026-04-16',
				main: './worker.js',
				d1_databases: [
					{
						binding: 'APP_DB',
						database_name: 'system-email-migration-test',
						database_id: '00000000-0000-0000-0000-000000000000',
						migrations_dir: './migrations',
					},
				],
			}),
		)
		for (const fileName of readdirSync(migrationsDirectory)
			.filter(
				(fileName) =>
					fileName.endsWith('.sql') && fileName < systemEmailAuthorityMigration,
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
		executeSql(
			temporary.path,
			configPath,
			statePath,
			`INSERT INTO email_inboxes (
				id, user_id, name, enabled, created_at, updated_at
			) VALUES (
				'user-inbox', 'user-1', 'private', 1,
				CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			);
			INSERT INTO email_threads (
				id, user_id, inbox_id, subject_normalized, last_message_at,
				created_at, updated_at
			) VALUES
				(
					'valid-new-thread', 'system:email', NULL, 'valid',
					CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				),
				(
					'invalid-cross-owner-thread', 'system:email', 'user-inbox',
					'invalid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				);`,
		)
		copyFileSync(
			new URL(systemEmailAuthorityMigration, migrationsDirectory),
			join(migrationPath, systemEmailAuthorityMigration),
		)

		const rejected = runWrangler(temporary.path, ...applyArguments)
		expect(rejected.error).toBeUndefined()
		expect(rejected.status).not.toBe(0)
		expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
			'CHECK constraint failed',
		)
		expect(
			readDatabaseRow(
				statePath,
				`SELECT
					(SELECT COUNT(*) FROM sqlite_master
						WHERE type = 'table'
							AND name = 'system_email_graph_authority') AS marker_table,
					(SELECT COUNT(*) FROM pragma_table_info(
						'system_email_daily_counters'
					) WHERE name = 'operation_token') AS operation_token,
					(SELECT COUNT(*) FROM system_email_threads
						WHERE id = 'valid-new-thread') AS copied_thread,
					(SELECT COUNT(*) FROM d1_migrations
						WHERE name = '${systemEmailAuthorityMigration}') AS ledger;`,
			),
		).toEqual({
			marker_table: 0,
			operation_token: 0,
			copied_thread: 0,
			ledger: 0,
		})

		executeSql(
			temporary.path,
			configPath,
			statePath,
			`DELETE FROM email_threads
			WHERE id = 'invalid-cross-owner-thread';`,
		)
		expectWranglerSuccess(runWrangler(temporary.path, ...applyArguments))
		expect(
			readDatabaseRow(
				statePath,
				`SELECT
					authority, graph_mismatch_count, provider_link_count,
					(SELECT COUNT(*) FROM system_email_threads
						WHERE id = 'valid-new-thread') AS copied_thread,
					(SELECT COUNT(*) FROM sqlite_master
						WHERE type = 'table'
							AND name = 'system_email_graph_migration_checks')
						AS check_table
				FROM system_email_graph_authority
				WHERE singleton = 1;`,
			),
		).toEqual({
			authority: 'dedicated',
			graph_mismatch_count: 0,
			provider_link_count: 0,
			copied_thread: 1,
			check_table: 0,
		})
	},
)
