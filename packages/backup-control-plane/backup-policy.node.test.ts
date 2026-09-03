import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { test } from 'vitest'

import {
	BackupError,
	assertConfiguredIdentity,
	assertRemoteDatabaseIdentity,
	backupPayload,
	configuredSourceDatabases,
	declaredSourceDatabases,
	isBackupEnabled,
	objectKeyForBookmark,
	primarySourceDatabase,
	resolveSourceDatabase,
	restoreImportOrder,
	sourceDatabaseFromObjectPrefix,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	DATABASE_ID,
	environment,
} from './backup-control-plane-test-support.ts'

const PRODUCTION_APP_DB_ID = '8c1014d1-6b41-4695-a0a2-159071f0f919'
const PRODUCTION_JOBS_DB_ID = '5410331e-4d25-47e4-a1e5-a248f7cc764c'
const JOBS_DATABASE_ID = '44444444-4444-4444-8444-444444444444'

function multiDatabaseEnv() {
	const env = environment()
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${env.SOURCE_DATABASE_ID},${JOBS_DATABASE_ID}`
	return env
}

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
	assert.notEqual(
		objectKeyForBookmark(prefix, 'bookmark-1'),
		objectKeyForBookmark(prefix, 'bookmark-2'),
	)
})

test('falls back to SOURCE_DATABASE_ID when SOURCE_DATABASES is unset', () => {
	const env = environment()
	assert.deepEqual(configuredSourceDatabases(env), [
		{ id: DATABASE_ID, name: 'production-db' },
	])
	assert.deepEqual(resolveSourceDatabase(env, undefined), {
		id: DATABASE_ID,
		name: 'production-db',
	})
})

test('exports a database-specific prefix for each SOURCE_DATABASES entry', () => {
	const env = multiDatabaseEnv()
	assert.deepEqual(configuredSourceDatabases(env), [
		{ id: DATABASE_ID, name: 'production-db' },
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	])
	const app = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	assert.equal(app.objectPrefix, `daily/d1/${DATABASE_ID}/2026-07-22`)
	const jobs = backupPayload(env, new Date('2026-07-22T02:15:00Z'), {
		id: JOBS_DATABASE_ID,
		name: 'kody-jobs',
	})
	assert.equal(jobs.objectPrefix, `daily/d1/${JOBS_DATABASE_ID}/2026-07-22`)
	assert.equal(
		jobs.manifestKey,
		`daily/d1/${JOBS_DATABASE_ID}/2026-07-22/manifest.json`,
	)
	assert.equal(
		workflowInstanceId(JOBS_DATABASE_ID, jobs.day),
		`d1-backup-${JOBS_DATABASE_ID}-2026-07-22`,
	)
	assert.deepEqual(
		sourceDatabaseFromObjectPrefix(
			env,
			jobs.objectPrefix,
			jobs.day,
			jobs.retentionTier,
		),
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	)
	assert.deepEqual(resolveSourceDatabase(env, 'kody-jobs'), {
		id: JOBS_DATABASE_ID,
		name: 'kody-jobs',
	})
	assert.deepEqual(resolveSourceDatabase(env, JOBS_DATABASE_ID.toUpperCase()), {
		id: JOBS_DATABASE_ID,
		name: 'kody-jobs',
	})
	assert.throws(
		() => resolveSourceDatabase(env, 'unknown-db'),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'unknown-source-database',
	)
})

test('rejects SOURCE_DATABASES entries that are missing from the allowlist', () => {
	const env = multiDatabaseEnv()
	env.ALLOWED_SOURCE_DATABASE_IDS = DATABASE_ID
	assert.throws(
		() => assertConfiguredIdentity(env),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'source-not-allowlisted',
	)
})

test('requires SOURCE_DATABASE_ID/NAME to appear in SOURCE_DATABASES', () => {
	const env = environment()
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${DATABASE_ID},${JOBS_DATABASE_ID}`
	assert.throws(
		() => assertConfiguredIdentity(env),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'source-not-allowlisted',
	)
})

test('committed control-plane allowlist includes production kody-jobs', async () => {
	const wrangler = await readFile(
		new URL('./wrangler.jsonc', import.meta.url),
		'utf8',
	)
	assert.match(
		wrangler,
		new RegExp(
			`"ALLOWED_SOURCE_DATABASE_IDS": "${PRODUCTION_APP_DB_ID},${PRODUCTION_JOBS_DB_ID}"`,
		),
	)
	assert.ok(
		wrangler.includes(
			`\\"${PRODUCTION_JOBS_DB_ID}\\",\\"name\\":\\"kody-jobs\\"`,
		),
		'SOURCE_DATABASES must list production kody-jobs',
	)
	assert.ok(
		wrangler.includes(`\\"${PRODUCTION_APP_DB_ID}\\",\\"name\\":\\"kody\\"`),
		'SOURCE_DATABASES must list production kody',
	)
})

test('declaredSourceDatabases uses the sealed day list and notes absent configured DBs', () => {
	const env = multiDatabaseEnv()
	assert.deepEqual(declaredSourceDatabases(env), [primarySourceDatabase(env)])
	assert.deepEqual(declaredSourceDatabases(env, []), [
		primarySourceDatabase(env),
	])
	const declared = [
		{
			databaseId: DATABASE_ID,
			databaseName: 'production-db',
			manifestKey: `daily/d1/${DATABASE_ID}/2026-07-22/manifest.json`,
			manifestSha256: 'a'.repeat(64),
		},
		{
			databaseId: JOBS_DATABASE_ID,
			databaseName: 'kody-jobs',
			manifestKey: `daily/d1/${JOBS_DATABASE_ID}/2026-07-22/manifest.json`,
			manifestSha256: 'b'.repeat(64),
		},
	]
	assert.deepEqual(declaredSourceDatabases(env, declared), [
		{ id: DATABASE_ID, name: 'production-db' },
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	])
	assert.deepEqual(
		restoreImportOrder(declaredSourceDatabases(env, declared), {
			id: DATABASE_ID,
			name: 'production-db',
		}),
		[
			{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
			{ id: DATABASE_ID, name: 'production-db' },
		],
	)
	assert.throws(
		() =>
			declaredSourceDatabases(env, [
				{
					databaseId: '55555555-5555-4555-8555-555555555555',
					databaseName: 'other',
					manifestKey: 'daily/d1/other/2026-07-22/manifest.json',
					manifestSha256: 'c'.repeat(64),
				},
			]),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'restore-d1-source-not-configured',
	)
})
