import {
	refreshCompletedD1Export,
	verifySourceDatabaseIdentity,
	type ApiOptions,
} from './d1-export-api.ts'
import { runDurableExport, type DurableExportStep } from './durable-export.ts'
import {
	assertDuplicateMatchesManifest,
	isBucketLockPolicyPutError,
	putImmutableManifest,
	storeSignedDownload,
} from './immutable-storage.ts'
import {
	BackupError,
	backupPayload,
	errorCode,
	isBackupEnabled,
	objectKeyForBookmark,
	safeLog,
} from './backup-policy.ts'
import {
	type BackupEnvironment,
	type BackupManifest,
	type BackupPayload,
	type SqlStatementStats,
} from './backup-types.ts'
import { signBackupManifest } from './manifest-signing.ts'

/**
 * Persist per-object statement-length statistics next to the SQL object and
 * log them. An oversized statement means the object cannot be re-imported
 * through the D1 import API (SQLITE_TOOBIG); the backup completes, but
 * the condition is logged with failure status so observability and health
 * checks can alert on an un-restorable day.
 */
async function recordSqlStatementStats(input: {
	env: BackupEnvironment
	day: string
	instanceId: string
	objectKey: string
	stats: SqlStatementStats | undefined
}): Promise<void> {
	const { stats } = input
	// Step replays from pre-stats deployments have no measurements to record.
	if (!stats) return
	safeLog({
		event: 'backup-sql-stats',
		status: stats.oversizedStatementCount > 0 ? 'failure' : 'success',
		day: input.day,
		instanceId: input.instanceId,
		objectKey: input.objectKey,
		maxStatementBytes: stats.maxStatementBytes,
		oversizedStatementCount: stats.oversizedStatementCount,
	})
	if (stats.oversizedStatementCount > 0) {
		safeLog({
			event: 'backup-unrestorable-statements',
			status: 'failure',
			day: input.day,
			instanceId: input.instanceId,
			objectKey: input.objectKey,
			maxStatementBytes: stats.maxStatementBytes,
			oversizedStatementCount: stats.oversizedStatementCount,
		})
	}
	const body = JSON.stringify({
		schemaVersion: 1,
		day: input.day,
		objectKey: input.objectKey,
		maxStatementBytes: stats.maxStatementBytes,
		oversizedStatementCount: stats.oversizedStatementCount,
		importStatementLimitBytes: stats.limit,
	})
	// The stats object is advisory; an existing object from a replayed step
	// wins and is left alone (the prefix is under the bucket's immutable
	// lock, which rejects puts on existing keys with error 10069 before the
	// conditional is evaluated).
	await input.env.BACKUP_BUCKET.put(`${input.objectKey}.stats.json`, body, {
		onlyIf: { etagDoesNotMatch: '*' },
		httpMetadata: { contentType: 'application/json' },
	}).catch((error: unknown) => {
		if (isBucketLockPolicyPutError(error)) return null
		throw error
	})
}

interface BackupRuntimeEvent {
	instanceId: string
	payload: BackupPayload
	timestamp: Date
}

export interface BackupRuntimeStep extends DurableExportStep {
	do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>
	do<T>(name: string, callback: () => Promise<T>): Promise<T>
}

interface BackupRuntimeOptions {
	api?: ApiOptions
	downloadFetcher?: typeof fetch
}

function validatePayload(
	env: BackupEnvironment,
	payload: BackupPayload,
): BackupPayload {
	const expected = backupPayload(env, new Date(payload.scheduledAt))
	if (
		payload.day !== expected.day ||
		payload.objectPrefix !== expected.objectPrefix ||
		payload.manifestKey !== expected.manifestKey ||
		payload.retentionTier !== expected.retentionTier
	) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload did not match deterministic backup keys',
		)
	}
	if (!env.BUILD_COMMIT) {
		throw new BackupError('missing-commit', 'BUILD_COMMIT must be configured')
	}
	return expected
}

export async function runBackupRuntime(
	env: BackupEnvironment,
	event: BackupRuntimeEvent,
	step: BackupRuntimeStep,
	options: BackupRuntimeOptions = {},
): Promise<BackupManifest> {
	const startedAt = event.timestamp.toISOString()
	let payload: BackupPayload | undefined
	let objectKey: string | undefined
	try {
		if (!isBackupEnabled(env)) {
			throw new BackupError(
				'backup-disabled',
				'backup workflow is explicitly disabled',
			)
		}
		const checkedPayload = validatePayload(env, event.payload)
		payload = checkedPayload
		await step.do(
			'verify-source-identity',
			{ retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' },
			async () => verifySourceDatabaseIdentity(env, options.api),
		)
		const exported = await runDurableExport(env, step, {
			api: options.api,
		})
		const stored = await step.do(
			'stream-export-to-immutable-r2',
			{
				retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				// Refresh may restart the export when the short-lived poll result
				// has expired; the returned bookmark defines the immutable object key.
				const refreshed = await refreshCompletedD1Export(
					env,
					exported.bookmark,
					options.api,
				)
				const refreshedObjectKey = objectKeyForBookmark(
					checkedPayload.objectPrefix,
					refreshed.bookmark,
				)
				const uploaded = await storeSignedDownload(
					env.BACKUP_BUCKET,
					refreshedObjectKey,
					refreshed.signedUrl,
					options.downloadFetcher,
				)
				return {
					...uploaded,
					objectKey: refreshedObjectKey,
					bookmark: refreshed.bookmark,
				}
			},
		)
		objectKey = stored.objectKey
		const completedAt = await step.do('record-completion-time', async () =>
			new Date().toISOString(),
		)
		const unsignedManifest = {
			source: {
				accountId: env.SOURCE_ACCOUNT_ID,
				databaseId: env.SOURCE_DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
			},
			export: {
				bookmark: stored.bookmark,
				scheduledAt: checkedPayload.scheduledAt,
				startedAt,
				completedAt,
			},
			sql: {
				objectKey: stored.objectKey,
				bytes: stored.bytes,
				sha256: stored.sha256,
				r2Etag: stored.r2Etag,
			},
			buildCommit: env.BUILD_COMMIT,
			retentionTier: checkedPayload.retentionTier,
		}
		const manifest = await step.do<BackupManifest>(
			'verify-stored-object-and-write-immutable-manifest',
			{
				retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				// Finalization verifies the stored object against the durable
				// upload-step digest (size, ETag, full SHA-256 re-read). It must
				// not re-download from D1: expired poll results can only be
				// refreshed by starting a new export of a *newer* database
				// state, whose bytes legitimately differ from the stored object
				// whenever production wrote anything in between.
				await assertDuplicateMatchesManifest(
					env.BACKUP_BUCKET,
					checkedPayload.manifestKey,
					stored.objectKey,
					stored,
				)
				const signedManifest = await signBackupManifest(env, unsignedManifest)
				await putImmutableManifest(
					env.BACKUP_BUCKET,
					checkedPayload.manifestKey,
					signedManifest,
				)
				return signedManifest
			},
		)
		await step.do(
			'record-statement-stats',
			{ retries: { limit: 2, delay: '10 seconds' }, timeout: '2 minutes' },
			async () =>
				recordSqlStatementStats({
					env,
					day: checkedPayload.day,
					instanceId: event.instanceId,
					objectKey: stored.objectKey,
					stats: stored.sqlStatementStats,
				}),
		)
		safeLog({
			event: 'backup-success',
			status: 'success',
			day: checkedPayload.day,
			instanceId: event.instanceId,
			objectKey: stored.objectKey,
			manifestKey: checkedPayload.manifestKey,
			bytes: stored.bytes,
			sha256: stored.sha256,
		})
		return manifest
	} catch (error) {
		safeLog({
			event: 'backup-failure',
			status: 'failure',
			day: payload?.day,
			instanceId: event.instanceId,
			objectKey,
			manifestKey: payload?.manifestKey,
			errorCode: errorCode(error),
		})
		throw error
	}
}
