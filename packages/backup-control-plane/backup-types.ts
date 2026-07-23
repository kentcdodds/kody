export type RetentionTier = 'daily' | 'weekly'

export interface BackupEnvironment {
	BACKUP_BUCKET: R2Bucket
	BACKUP_WORKFLOW: Workflow
	CLOUDFLARE_API_TOKEN: string
	SOURCE_ACCOUNT_ID: string
	SOURCE_ACCOUNT_NAME: string
	SOURCE_DATABASE_ID: string
	SOURCE_DATABASE_NAME: string
	ALLOWED_SOURCE_ACCOUNT_IDS: string
	ALLOWED_SOURCE_DATABASE_IDS: string
	ENABLE_PRODUCTION_D1_BACKUPS: string
	BACKUP_BENCHMARK_APPROVED: string
	BUILD_COMMIT: string
	BACKUP_MAX_AGE_HOURS?: string
	BACKUP_MAX_SOURCE_BYTES?: string
}

export interface BackupPayload {
	scheduledAt: string
	day: string
	objectPrefix: string
	manifestKey: string
	retentionTier: RetentionTier
}

export interface BackupManifest {
	schemaVersion: 1
	source: {
		accountId: string
		accountName: string
		databaseId: string
		databaseName: string
	}
	bookmark: string
	scheduledAt: string
	startedAt: string
	completedAt: string
	objectKey: string
	bytes: number
	sha256: string
	r2Etag: string
	commit: string
	retentionTier: RetentionTier
}

export interface ExportReady {
	kind: 'complete'
	bookmark: string
	signedUrl: string
}

export interface ExportPending {
	kind: 'pending'
	bookmark: string
}

export type ExportState = ExportReady | ExportPending

export interface StoredBackup {
	bytes: number
	sha256: string
	r2Etag: string
	alreadyExisted: boolean
}

export interface LogRecord {
	event:
		| 'backup-disabled'
		| 'backup-catch-up-enqueued'
		| 'backup-enqueued'
		| 'backup-overlap'
		| 'backup-restarted'
		| 'backup-success'
		| 'backup-failure'
		| 'freshness-success'
		| 'freshness-stale'
		| 'source-size-success'
		| 'source-size-failure'
	status: 'success' | 'failure' | 'stale-success' | 'disabled'
	day?: string
	instanceId?: string
	objectKey?: string
	manifestKey?: string
	bytes?: number
	sha256?: string
	errorCode?: string
	ageHours?: number
	sourceBytes?: number
	maxSourceBytes?: number
}
