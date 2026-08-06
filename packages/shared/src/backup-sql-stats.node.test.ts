import assert from 'node:assert/strict'

import { test } from 'vitest'

import { d1ImportMaxStatementBytes } from './backup-restore-safety.ts'
import {
	backupSqlStatsRequired,
	backupSqlStatsSchemaVersion,
	parseBackupSqlStats,
} from './backup-sql-stats.ts'

test('backup SQL stats enforce the rollout cutoff and statement-limit consistency', () => {
	assert.equal(backupSqlStatsRequired('2026-07-27'), false)
	assert.equal(backupSqlStatsRequired('2026-07-28'), true)

	const valid = {
		schemaVersion: backupSqlStatsSchemaVersion,
		day: '2026-07-31',
		objectKey: 'daily/d1/database/2026-07-31/backup-bookmark.sql',
		maxStatementBytes: 50_000,
		oversizedStatementCount: 0,
		importStatementLimitBytes: d1ImportMaxStatementBytes,
	}
	assert.deepEqual(parseBackupSqlStats(valid), valid)

	const oversized = {
		...valid,
		maxStatementBytes: d1ImportMaxStatementBytes + 1,
		oversizedStatementCount: 1,
	}
	assert.deepEqual(parseBackupSqlStats(oversized), oversized)
	const differentRecordedLimit = {
		...valid,
		importStatementLimitBytes: d1ImportMaxStatementBytes + 1,
	}
	assert.deepEqual(
		parseBackupSqlStats(differentRecordedLimit),
		differentRecordedLimit,
	)

	for (const corrupt of [
		null,
		{ ...valid, schemaVersion: backupSqlStatsSchemaVersion + 1 },
		{ ...valid, importStatementLimitBytes: 0 },
		{ ...valid, maxStatementBytes: d1ImportMaxStatementBytes + 1 },
		{ ...valid, maxStatementBytes: 50_000, oversizedStatementCount: 1 },
	]) {
		assert.throws(() => parseBackupSqlStats(corrupt))
	}
})
