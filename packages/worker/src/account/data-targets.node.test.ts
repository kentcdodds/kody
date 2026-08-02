import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	accountExportForeignUserIdColumnsByTable,
	accountExportRedactedColumnsByTable,
	accountExportRedactedForeignUserId,
	accountOperatorOwnedD1Surfaces,
	accountUserDataPendingDropTargets,
	accountUserDataTargets,
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	getAccountD1UserColumnCoverage,
	getAccountExportExcludedD1Surfaces,
	isExcludedFromAccountExport,
	type UserScopedDataTarget,
} from './data-targets.ts'

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	for (const fileName of readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDir), 'utf8'))
	}
}

function matchFor(target: UserScopedDataTarget) {
	return buildUserScopedTargetMatch({
		target,
		mcpUserId: 'user-aaa',
		dbUserId: 42,
	})
}

test('shared user-scoped target match SQL is identical for deletion and export shapes', () => {
	const samples: Array<UserScopedDataTarget> = [
		{ kind: 'user_id', table: 'jobs' },
		{ kind: 'db_user_id', table: 'passkeys' },
		{ kind: 'db_user_target', table: 'verifications' },
		{
			kind: 'user_columns',
			table: 'user_follows',
			columns: ['follower_user_id', 'followee_user_id'],
		},
		{
			kind: 'null_user_column',
			table: 'platform_feedback',
			matchColumn: 'reviewed_by_user_id',
			nullColumns: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
			includeInExport: false,
		},
		{
			kind: 'replace_user_column',
			table: 'community_bans',
			matchColumn: 'banned_by_user_id',
			setColumn: 'banned_by_user_id',
			value: 'deleted-user',
		},
		{
			kind: 'replace_user_id_in_json_column',
			table: 'package_codemod_runs',
			column: 'filters_json',
			value: 'deleted-user',
			includeInExport: false,
			surface: 'package_codemod_runs_filters_json',
			reason: 'test',
		},
		{
			kind: 'bucket_parent',
			table: 'value_entries',
			parentTable: 'value_buckets',
		},
		{ kind: 'attachment_parent', table: 'email_attachments' },
		{
			kind: 'community_listing_child',
			table: 'community_stars',
			listingColumn: 'listing_id',
		},
		{ kind: 'mcp_memory_suppression' },
	]

	expect(matchFor(samples[0]!)).toEqual({
		table: 'jobs',
		whereSql: 'user_id = ?',
		qualifiedWhereSql: 'jobs.user_id = ?',
		params: ['user-aaa'],
		mutation: { kind: 'delete' },
	})
	expect(buildUserScopedDeleteOrUpdateSql(matchFor(samples[0]!))).toEqual({
		sql: 'DELETE FROM jobs WHERE user_id = ?',
		params: ['user-aaa'],
	})

	expect(matchFor(samples[1]!)).toEqual({
		table: 'passkeys',
		whereSql: 'user_id = ?',
		qualifiedWhereSql: 'passkeys.user_id = ?',
		params: [42],
		mutation: { kind: 'delete' },
	})
	expect(matchFor(samples[2]!)).toEqual({
		table: 'verifications',
		whereSql: 'target = ?',
		qualifiedWhereSql: 'verifications.target = ?',
		params: ['42'],
		mutation: { kind: 'delete' },
	})
	expect(matchFor(samples[3]!)).toEqual({
		table: 'user_follows',
		whereSql: 'follower_user_id = ? OR followee_user_id = ?',
		qualifiedWhereSql:
			'user_follows.follower_user_id = ? OR user_follows.followee_user_id = ?',
		params: ['user-aaa', 'user-aaa'],
		mutation: { kind: 'delete' },
	})

	const nullMatch = matchFor(samples[4]!)
	expect(nullMatch.mutation).toEqual({
		kind: 'null_columns',
		columns: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
	})
	expect(buildUserScopedDeleteOrUpdateSql(nullMatch)).toEqual({
		sql: `UPDATE platform_feedback
						SET reviewed_by_user_id = NULL, reviewed_at = NULL, admin_note = NULL
						WHERE reviewed_by_user_id = ?`,
		params: ['user-aaa'],
	})

	const replaceMatch = matchFor(samples[5]!)
	expect(buildUserScopedDeleteOrUpdateSql(replaceMatch)).toEqual({
		sql: `UPDATE community_bans
						SET banned_by_user_id = ?
						WHERE banned_by_user_id = ?`,
		params: ['deleted-user', 'user-aaa'],
	})

	const replaceJsonMatch = matchFor(samples[6]!)
	expect(replaceJsonMatch).toEqual({
		table: 'package_codemod_runs',
		whereSql: 'filters_json LIKE ?',
		qualifiedWhereSql: 'package_codemod_runs.filters_json LIKE ?',
		params: ['%"user-aaa"%'],
		mutation: {
			kind: 'replace_json_string',
			column: 'filters_json',
			search: '"user-aaa"',
			replacement: '"deleted-user"',
		},
	})
	expect(buildUserScopedDeleteOrUpdateSql(replaceJsonMatch)).toEqual({
		sql: `UPDATE package_codemod_runs
						SET filters_json = REPLACE(filters_json, ?, ?)
						WHERE filters_json LIKE ?`,
		params: ['"user-aaa"', '"deleted-user"', '%"user-aaa"%'],
	})

	expect(matchFor(samples[7]!).qualifiedWhereSql).toBe(
		`value_entries.bucket_id IN (
						SELECT id FROM value_buckets WHERE user_id = ?
					)`,
	)
	expect(matchFor(samples[8]!).qualifiedWhereSql).toBe(
		`email_attachments.message_id IN (
						SELECT id FROM email_messages WHERE user_id = ?
					)`,
	)
	expect(matchFor(samples[9]!).qualifiedWhereSql).toBe(
		`community_stars.listing_id IN (
						SELECT id FROM community_listings WHERE owner_user_id = ?
					)`,
	)
	expect(matchFor(samples[10]!)).toEqual({
		table: 'mcp_memory_conversation_suppressions',
		whereSql: 'user_id = ?',
		qualifiedWhereSql: 'mcp_memory_conversation_suppressions.user_id = ?',
		params: ['user-aaa'],
		mutation: { kind: 'delete' },
	})
})

test('every accountUserDataTargets kind has a shared match builder and export guards', () => {
	for (const target of accountUserDataTargets) {
		const match = matchFor(target)
		expect(match.table.length).toBeGreaterThan(0)
		expect(match.whereSql.length).toBeGreaterThan(0)
		expect(match.qualifiedWhereSql).toContain(match.table)
		expect(match.params.length).toBeGreaterThan(0)
		const statement = buildUserScopedDeleteOrUpdateSql(match)
		expect(statement.sql).toContain(match.table)
		expect(statement.params.length).toBeGreaterThan(0)
	}

	expect(accountExportRedactedColumnsByTable.users).toContain('password_hash')
	expect(accountExportRedactedColumnsByTable.secret_entries).toEqual(
		expect.arrayContaining(['encrypted_value', 'lookup_hash']),
	)
	expect(accountExportForeignUserIdColumnsByTable.user_follows).toEqual(
		expect.arrayContaining(['follower_user_id', 'followee_user_id']),
	)
	expect(typeof accountExportRedactedForeignUserId).toBe('string')
	expect(accountExportRedactedForeignUserId.length).toBeGreaterThan(0)

	const excludedListingChildren = accountUserDataTargets.filter(
		(target) =>
			target.kind === 'community_listing_child' &&
			target.includeInExport === false,
	)
	expect(excludedListingChildren.length).toBeGreaterThan(0)
	expect(
		excludedListingChildren.every((target) =>
			target.table.startsWith('community_'),
		),
	).toBe(true)
})

test('dedicated system email tables are explicit operator-owned exclusions', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrations(db)
	const expectedTables = [
		'system_email_attachments',
		'system_email_delivery_events',
		'system_email_messages',
		'system_email_threads',
	]
	expect(
		accountOperatorOwnedD1Surfaces.map((surface) => surface.table).sort(),
	).toEqual(expectedTables)
	for (const table of expectedTables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`)
			.all() as Array<{ name: string }>
		expect(columns.map((column) => column.name)).not.toContain('user_id')
		expect(
			accountUserDataTargets.some(
				(target) => 'table' in target && target.table === table,
			),
		).toBe(false)
	}
	expect(getAccountExportExcludedD1Surfaces()).toEqual(
		expect.arrayContaining(
			expectedTables.map((table) =>
				expect.objectContaining({
					name: table,
					reason: expect.stringContaining('operator-owned system email'),
				}),
			),
		),
	)
})

test('final schema drops entitlement_daily_counters without stale inventory coverage', () => {
	expect(
		accountUserDataPendingDropTargets.some(
			(target) => target.table === 'entitlement_daily_counters',
		),
	).toBe(false)
	expect(
		accountUserDataTargets.some(
			(target) =>
				'table' in target && target.table === 'entitlement_daily_counters',
		),
	).toBe(false)
	expect(getAccountExportExcludedD1Surfaces()).not.toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: 'entitlement_daily_counters' }),
		]),
	)

	const deletionStatements = accountUserDataTargets.map((target) => {
		const match = matchFor(target)
		return buildUserScopedDeleteOrUpdateSql(match).sql
	})
	expect(deletionStatements.join('\n')).not.toMatch(
		/entitlement_daily_counters/u,
	)

	const exportStatements = accountUserDataTargets
		.filter((target) => !isExcludedFromAccountExport(target))
		.map((target) => {
			const match = matchFor(target)
			return `SELECT * FROM ${match.table} WHERE ${match.qualifiedWhereSql}`
		})
	expect(exportStatements.join('\n')).not.toMatch(/entitlement_daily_counters/u)

	const db = new DatabaseSync(':memory:')
	applyMigrations(db)
	const tableExists = db
		.prepare(
			`SELECT 1 AS present
			FROM sqlite_schema
			WHERE type = 'table' AND name = 'entitlement_daily_counters'`,
		)
		.get() as { present: number } | undefined
	expect(tableExists).toBeUndefined()

	const liveUserColumns = new Set<string>()
	const tables = db
		.prepare(
			`SELECT name
			FROM sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			ORDER BY name`,
		)
		.all() as Array<{ name: string }>
	for (const table of tables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
			.all() as Array<{ name: string }>
		for (const column of columns) {
			if (column.name === 'user_id' || column.name.endsWith('_user_id')) {
				liveUserColumns.add(`${table.name}.${column.name}`)
			}
		}
	}
	const coveredColumns = getAccountD1UserColumnCoverage()
	expect(coveredColumns.has('entitlement_daily_counters.user_id')).toBe(false)
	expect(liveUserColumns.has('entitlement_daily_counters.user_id')).toBe(false)
	const missing = [...liveUserColumns].filter(
		(column) => !coveredColumns.has(column),
	)
	const stale = [...coveredColumns].filter(
		(column) => !liveUserColumns.has(column),
	)
	expect(missing).toEqual([])
	expect(stale).toEqual([])
})
