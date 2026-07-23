import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	BackupError,
	assertRemoteDatabaseIdentity,
	backupPayload,
	isBackupEnabled,
	objectKeyForBookmark,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	DATABASE_ID,
	environment,
} from './backup-control-plane-test-support.ts'

test('requires both explicit enable and benchmark approval', () => {
	const env = environment()
	assert.equal(isBackupEnabled(env), true)
	env.BACKUP_BENCHMARK_APPROVED = 'false'
	assert.equal(isBackupEnabled(env), false)
	env.BACKUP_BENCHMARK_APPROVED = 'true'
	env.ENABLE_PRODUCTION_D1_BACKUPS = 'TRUE'
	assert.equal(isBackupEnabled(env), false)
})

test('guards configured account/database allowlists and live D1 UUID/name', () => {
	const env = environment()
	assert.doesNotThrow(() =>
		assertRemoteDatabaseIdentity(env, {
			uuid: DATABASE_ID,
			name: 'production-db',
		}),
	)
	assert.throws(
		() =>
			assertRemoteDatabaseIdentity(env, {
				uuid: DATABASE_ID,
				name: 'wrong-db',
			}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'source-identity-mismatch',
	)
	env.ALLOWED_SOURCE_DATABASE_IDS = '33333333-3333-4333-8333-333333333333'
	assert.throws(
		() =>
			assertRemoteDatabaseIdentity(env, {
				uuid: DATABASE_ID,
				name: 'production-db',
			}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'source-not-allowlisted',
	)
	const mixedCaseEnv = environment()
	mixedCaseEnv.SOURCE_ACCOUNT_ID = 'abcdefabcdefabcdefabcdefabcdefab'
	mixedCaseEnv.ALLOWED_SOURCE_ACCOUNT_IDS =
		mixedCaseEnv.SOURCE_ACCOUNT_ID.toUpperCase()
	mixedCaseEnv.SOURCE_DATABASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	mixedCaseEnv.ALLOWED_SOURCE_DATABASE_IDS =
		mixedCaseEnv.SOURCE_DATABASE_ID.toUpperCase()
	assert.doesNotThrow(() =>
		assertRemoteDatabaseIdentity(mixedCaseEnv, {
			uuid: mixedCaseEnv.SOURCE_DATABASE_ID.toUpperCase(),
			name: 'production-db',
		}),
	)
})

test('builds deterministic daily and Sunday-UTC weekly retention keys', () => {
	const env = environment()
	const daily = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const sameDay = backupPayload(env, new Date('2026-07-22T23:59:00Z'))
	assert.equal(daily.day, sameDay.day)
	assert.equal(daily.objectPrefix, sameDay.objectPrefix)
	assert.equal(daily.manifestKey, sameDay.manifestKey)
	assert.equal(daily.objectPrefix, `daily/d1/${DATABASE_ID}/2026-07-22`)
	assert.match(
		objectKeyForBookmark(daily.objectPrefix, 'bookmark-1'),
		new RegExp(`^daily/d1/${DATABASE_ID}/2026-07-22/backup-[0-9a-f]+\\.sql$`),
	)
	assert.equal(daily.retentionTier, 'daily')
	assert.equal(
		workflowInstanceId(DATABASE_ID, daily.day),
		`d1-backup-${DATABASE_ID}-2026-07-22`,
	)
	const weekly = backupPayload(env, new Date('2026-07-26T02:15:00Z'))
	assert.equal(weekly.retentionTier, 'weekly')
	assert.equal(
		weekly.manifestKey,
		`weekly/d1/${DATABASE_ID}/2026-07-26/manifest.json`,
	)
})

test('bookmark-derived keys reject unsafe bookmark path input', () => {
	const prefix = `daily/d1/${DATABASE_ID}/2026-07-22`
	for (const bookmark of [
		'',
		'.',
		'..',
		'../escape',
		'slash/value',
		'line\n',
	]) {
		assert.throws(
			() => objectKeyForBookmark(prefix, bookmark),
			(error: unknown) =>
				error instanceof BackupError && error.code === 'unsafe-export-bookmark',
		)
	}
	assert.equal(
		objectKeyForBookmark(prefix, 'bookmark-1'),
		objectKeyForBookmark(prefix, 'bookmark-1'),
	)
	assert.notEqual(
		objectKeyForBookmark(prefix, 'bookmark-1'),
		objectKeyForBookmark(prefix, 'bookmark-2'),
	)
})
