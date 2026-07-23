import {
	type BackupEnvironment,
	type BackupPayload,
	type LogRecord,
	type RetentionTier,
} from './backup-types.ts'

const CLOUDFLARE_ID_PATTERN =
	/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export class BackupError extends Error {
	readonly code: string
	readonly retryable: boolean

	constructor(code: string, message: string, retryable = false) {
		super(message)
		this.name = 'BackupError'
		this.code = code
		this.retryable = retryable
	}
}

export function isBackupEnabled(env: BackupEnvironment): boolean {
	return (
		env.ENABLE_PRODUCTION_D1_BACKUPS === 'true' &&
		env.BACKUP_BENCHMARK_APPROVED === 'true'
	)
}

function parseAllowlist(value: string, field: string): Set<string> {
	const entries = value
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
	if (entries.length === 0) {
		throw new BackupError('empty-allowlist', `${field} cannot be empty`)
	}
	return new Set(entries)
}

export function assertConfiguredIdentity(env: BackupEnvironment): void {
	if (
		!CLOUDFLARE_ID_PATTERN.test(env.SOURCE_ACCOUNT_ID) ||
		!CLOUDFLARE_ID_PATTERN.test(env.SOURCE_DATABASE_ID)
	) {
		throw new BackupError(
			'invalid-source-id',
			'source account and database IDs must be UUIDs',
		)
	}
	if (
		!parseAllowlist(
			env.ALLOWED_SOURCE_ACCOUNT_IDS,
			'ALLOWED_SOURCE_ACCOUNT_IDS',
		).has(env.SOURCE_ACCOUNT_ID.toLowerCase()) ||
		!parseAllowlist(
			env.ALLOWED_SOURCE_DATABASE_IDS,
			'ALLOWED_SOURCE_DATABASE_IDS',
		).has(env.SOURCE_DATABASE_ID.toLowerCase())
	) {
		throw new BackupError(
			'source-not-allowlisted',
			'configured source identity is not allowlisted',
		)
	}
	if (!env.SOURCE_DATABASE_NAME) {
		throw new BackupError(
			'missing-source-name',
			'source database name is required',
		)
	}
}

export function assertRemoteDatabaseIdentity(
	env: BackupEnvironment,
	database: { uuid: string; name: string },
): void {
	assertConfiguredIdentity(env)
	if (
		database.uuid.toLowerCase() !== env.SOURCE_DATABASE_ID.toLowerCase() ||
		database.name !== env.SOURCE_DATABASE_NAME
	) {
		throw new BackupError(
			'source-identity-mismatch',
			'Cloudflare D1 identity did not match the configured UUID and name',
		)
	}
}

export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10)
}

export function retentionTier(day: string): RetentionTier {
	const date = new Date(`${day}T00:00:00.000Z`)
	if (Number.isNaN(date.valueOf())) {
		throw new BackupError('invalid-day', 'scheduled day is invalid')
	}
	// Sunday UTC is the weekly retention boundary.
	return date.getUTCDay() === 0 ? 'weekly' : 'daily'
}

export function backupPayload(
	env: BackupEnvironment,
	scheduledAt: Date,
): BackupPayload {
	assertConfiguredIdentity(env)
	const day = utcDay(scheduledAt)
	const tier = retentionTier(day)
	const prefix = `${tier}/d1/${env.SOURCE_DATABASE_ID}/${day}`
	return {
		scheduledAt: scheduledAt.toISOString(),
		day,
		objectPrefix: prefix,
		manifestKey: `${prefix}/manifest.json`,
		retentionTier: tier,
	}
}

export function objectKeyForBookmark(
	objectPrefix: string,
	bookmark: string,
): string {
	if (
		!/^[A-Za-z0-9._:-]{1,256}$/.test(bookmark) ||
		bookmark === '.' ||
		bookmark === '..'
	) {
		throw new BackupError(
			'unsafe-export-bookmark',
			'D1 export bookmark cannot be safely mapped to an object key',
		)
	}
	const encoded = [...new TextEncoder().encode(bookmark)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
	return `${objectPrefix}/backup-${encoded}.sql`
}

export function isBookmarkObjectKey(
	objectPrefix: string,
	objectKey: string,
): boolean {
	if (!objectKey.startsWith(`${objectPrefix}/`)) return false
	const filename = objectKey.slice(objectPrefix.length + 1)
	return /^backup-(?:[0-9a-f]{2}){1,256}\.sql$/.test(filename)
}

export function workflowInstanceId(databaseId: string, day: string): string {
	return `d1-backup-${databaseId}-${day}`
}

export function safeLog(
	record: LogRecord,
	logger: Pick<Console, 'log' | 'error'> = console,
): void {
	const output = JSON.stringify(record)
	if (record.status === 'failure') logger.error(output)
	else logger.log(output)
}

export function errorCode(error: unknown): string {
	return error instanceof BackupError ? error.code : 'unexpected-error'
}
