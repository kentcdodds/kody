import {
	refreshCompletedD1Export,
	verifySourceDatabaseIdentity,
	type ApiOptions,
} from './d1-export-api.ts'
import { runDurableExport, type DurableExportStep } from './durable-export.ts'
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
import { signBackupManifest } from './manifest-signing.ts'

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
			async () => {
				const refreshed = await refreshCompletedD1Export(
					env,
					exported.bookmark,
					options.api,
				)
				return storeSignedDownload(
					env.BACKUP_BUCKET,
					checkedObjectKey,
					refreshed.signedUrl,
					options.downloadFetcher,
				)
			},
		)
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
				bookmark: exported.bookmark,
				scheduledAt: checkedPayload.scheduledAt,
				startedAt,
				completedAt,
			},
			sql: {
				objectKey: checkedObjectKey,
				bytes: stored.bytes,
				sha256: stored.sha256,
				r2Etag: stored.r2Etag,
			},
			buildCommit: env.BUILD_COMMIT,
			retentionTier: checkedPayload.retentionTier,
		}
		const manifest = await step.do<BackupManifest>(
			'verify-source-and-write-immutable-manifest',
			{
				retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				const refreshed = await refreshCompletedD1Export(
					env,
					exported.bookmark,
					options.api,
				)
				await assertDuplicateMatchesManifest(
					env.BACKUP_BUCKET,
					checkedPayload.manifestKey,
					checkedObjectKey,
					stored,
					{
						signedUrl: refreshed.signedUrl,
						fetcher: options.downloadFetcher,
					},
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
		throw error
	}
}
