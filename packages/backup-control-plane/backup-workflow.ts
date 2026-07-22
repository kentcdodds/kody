import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { verifySourceDatabaseIdentity } from './d1-export-api.ts'
import { runDurableExport } from './durable-export.ts'
import {
	assertDuplicateMatchesManifest,
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
} from './backup-types.ts'

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

export class ProductionD1BackupWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	BackupPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<BackupPayload>>,
		step: WorkflowStep,
	): Promise<BackupManifest> {
		const startedAt = event.timestamp.toISOString()
		let payload: BackupPayload | undefined
		let objectKey: string | undefined
		try {
			if (!isBackupEnabled(this.env)) {
				throw new BackupError(
					'backup-disabled',
					'backup workflow is explicitly disabled',
				)
			}
			const checkedPayload = validatePayload(this.env, event.payload)
			payload = checkedPayload
			await step.do(
				'verify-source-identity',
				{ retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' },
				async () => verifySourceDatabaseIdentity(this.env),
			)
			const exported = await runDurableExport(this.env, step)
			const checkedObjectKey = objectKeyForBookmark(
				checkedPayload.objectPrefix,
				exported.bookmark,
			)
			objectKey = checkedObjectKey
			const stored = await step.do(
				'stream-export-to-immutable-r2',
				{
					retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
					timeout: '15 minutes',
				},
				async () =>
					storeSignedDownload(
						this.env.BACKUP_BUCKET,
						checkedObjectKey,
						exported.signedUrl,
					),
			)
			await step.do(
				'verify-duplicate-object-manifest',
				{ retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' },
				async () =>
					assertDuplicateMatchesManifest(
						this.env.BACKUP_BUCKET,
						checkedPayload.manifestKey,
						checkedObjectKey,
						stored,
					),
			)
			const completedAt = await step.do('record-completion-time', async () =>
				new Date().toISOString(),
			)
			const manifest: BackupManifest = {
				schemaVersion: 1,
				source: {
					accountId: this.env.SOURCE_ACCOUNT_ID,
					accountName: this.env.SOURCE_ACCOUNT_NAME,
					databaseId: this.env.SOURCE_DATABASE_ID,
					databaseName: this.env.SOURCE_DATABASE_NAME,
				},
				bookmark: exported.bookmark,
				scheduledAt: checkedPayload.scheduledAt,
				startedAt,
				completedAt,
				objectKey: checkedObjectKey,
				bytes: stored.bytes,
				sha256: stored.sha256,
				r2Etag: stored.r2Etag,
				commit: this.env.BUILD_COMMIT,
				retentionTier: checkedPayload.retentionTier,
			}
			await step.do(
				'write-immutable-manifest',
				{
					retries: { limit: 4, delay: '10 seconds', backoff: 'exponential' },
					timeout: '1 minute',
				},
				async () =>
					putImmutableManifest(
						this.env.BACKUP_BUCKET,
						checkedPayload.manifestKey,
						manifest,
					),
			)
			safeLog({
				event: 'backup-success',
				status: 'success',
				day: checkedPayload.day,
				instanceId: event.instanceId,
				objectKey: checkedObjectKey,
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
			if (error instanceof BackupError && !error.retryable) {
				throw new NonRetryableError(error.message, error.code)
			}
			throw error
		}
	}
}
