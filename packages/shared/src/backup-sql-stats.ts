import { d1ImportMaxStatementBytes } from './backup-restore-safety.ts'

export const backupSqlStatsSchemaVersion = 1

/**
 * SQL statement statistics became mandatory for D1 backup objects after the
 * stats-aware control plane was deployed. Older retained objects remain
 * usable, but a missing stats sibling on this day or later is unsafe.
 */
export const backupSqlStatsRequiredFromDay = '2026-07-28'

export type BackupSqlStats = {
	schemaVersion: typeof backupSqlStatsSchemaVersion
	day: string
	objectKey: string
	maxStatementBytes: number
	oversizedStatementCount: number
	importStatementLimitBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

export function backupSqlStatsKey(objectKey: string): string {
	return `${objectKey}.stats.json`
}

export function backupSqlStatsRequired(day: string): boolean {
	return day >= backupSqlStatsRequiredFromDay
}

export function parseBackupSqlStats(value: unknown): BackupSqlStats {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupSqlStatsSchemaVersion ||
		typeof value.day !== 'string' ||
		typeof value.objectKey !== 'string' ||
		!isNonNegativeSafeInteger(value.maxStatementBytes) ||
		!isNonNegativeSafeInteger(value.oversizedStatementCount) ||
		value.importStatementLimitBytes !== d1ImportMaxStatementBytes ||
		(value.oversizedStatementCount === 0) !==
			Number(value.maxStatementBytes) <= d1ImportMaxStatementBytes
	) {
		throw new Error('backup SQL stats are corrupt')
	}
	return value as BackupSqlStats
}
