import { expect, test } from 'vitest'
import {
	accountExportForeignUserIdColumnsByTable,
	accountExportRedactedColumnsByTable,
	accountExportRedactedForeignUserId,
	accountUserDataTargets,
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	type UserScopedDataTarget,
} from './account-data-targets.ts'

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

	expect(matchFor(samples[6]!).qualifiedWhereSql).toBe(
		`value_entries.bucket_id IN (
						SELECT id FROM value_buckets WHERE user_id = ?
					)`,
	)
	expect(matchFor(samples[7]!).qualifiedWhereSql).toBe(
		`email_attachments.message_id IN (
						SELECT id FROM email_messages WHERE user_id = ?
					)`,
	)
	expect(matchFor(samples[8]!).qualifiedWhereSql).toBe(
		`community_stars.listing_id IN (
						SELECT id FROM community_listings WHERE owner_user_id = ?
					)`,
	)
	expect(matchFor(samples[9]!)).toEqual({
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
