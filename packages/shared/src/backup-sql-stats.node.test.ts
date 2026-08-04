import assert from 'node:assert/strict'

import { test } from 'vitest'

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
		importStatementLimitBytes: 100_000,
	}
	assert.deepEqual(parseBackupSqlStats(valid), valid)

	for (const corrupt of [
		{ ...valid, importStatementLimitBytes: 100_001 },
		{ ...valid, maxStatementBytes: 100_001 },
		{ ...valid, maxStatementBytes: 50_000, oversizedStatementCount: 1 },
	]) {
		assert.throws(() => parseBackupSqlStats(corrupt))
	}
})
