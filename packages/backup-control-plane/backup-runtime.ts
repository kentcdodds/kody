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
	objectKeyForPayload,
	safeLog,
} from './backup-policy.ts'
import { mailboxPreDropRuntimePayload } from './mailbox-pre-drop-policy.ts'
import {
	type BackupEnvironment,
	type BackupManifest,
	type BackupPayload,
	type LegacyScheduledBackupPayload,
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
	payload: unknown
	timestamp: Date
}

export interface BackupRuntimeStep extends DurableExportStep {
	do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>
	do<T>(name: string, callback: () => Promise<T>): Promise<T>
}

interface BackupRuntimeOptions {
	api?: ApiOptions
	downloadFetcher?: typeof fetch
	payloadKind?: BackupPayload['kind']
}

const legacyScheduledPayloadKeys = [
	'scheduledAt',
	'day',
	'objectPrefix',
	'manifestKey',
	'retentionTier',
] as const
const scheduledPayloadKeys = ['kind', ...legacyScheduledPayloadKeys] as const
const mailboxPreDropPayloadKeys = [
	'kind',
	'requestId',
	'nonce',
	'requestedAt',
	'scheduledAt',
	'day',
	'objectPrefix',
	'manifestKey',
	'retentionTier',
] as const

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	)
}

function hasExactDataKeys(
	value: Record<string, unknown>,
	expectedKeys: ReadonlyArray<string>,
): boolean {
	const actualKeys = Reflect.ownKeys(value)
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every(
			(key) => typeof key === 'string' && expectedKeys.includes(key),
		) &&
		expectedKeys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			return descriptor?.enumerable === true && 'value' in descriptor
		})
	)
}

function canonicalScheduledDate(value: unknown): Date {
	if (typeof value !== 'string') {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow scheduledAt must be a canonical UTC timestamp',
		)
	}
	const date = new Date(value)
	if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow scheduledAt must be a canonical UTC timestamp',
		)
	}
	return date
}

function matchesExpectedPayload(
	payload: Record<string, unknown>,
	expected: BackupPayload | LegacyScheduledBackupPayload,
): boolean {
	return Object.entries(expected).every(
		([key, value]) => payload[key] === value,
	)
}

function validatePayload(
	env: BackupEnvironment,
	payload: unknown,
	allowedKind: BackupPayload['kind'],
): BackupPayload {
	if (!isPlainDataRecord(payload)) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload must be a plain object with exact data fields',
		)
	}
	if (!Object.hasOwn(payload, 'kind')) {
		if (allowedKind !== 'scheduled') {
			throw new BackupError(
				'invalid-workflow-payload-kind',
				'workflow payload kind is not approved for this Workflow',
			)
		}
		if (!hasExactDataKeys(payload, legacyScheduledPayloadKeys)) {
			throw new BackupError(
				'invalid-workflow-payload',
				'legacy workflow payload did not have exact scheduled fields',
			)
		}
		const expected = backupPayload(
			env,
			canonicalScheduledDate(payload.scheduledAt),
		)
		const legacyExpected: LegacyScheduledBackupPayload = {
			scheduledAt: expected.scheduledAt,
			day: expected.day,
			objectPrefix: expected.objectPrefix,
			manifestKey: expected.manifestKey,
			retentionTier: expected.retentionTier,
		}
		if (!matchesExpectedPayload(payload, legacyExpected)) {
			throw new BackupError(
				'invalid-workflow-payload',
				'legacy workflow payload did not match deterministic backup keys',
			)
		}
		if (!env.BUILD_COMMIT) {
			throw new BackupError('missing-commit', 'BUILD_COMMIT must be configured')
		}
		return expected
	}
	if (payload.kind !== allowedKind) {
		throw new BackupError(
			'invalid-workflow-payload-kind',
			'workflow payload kind is not approved for this Workflow',
		)
	}
	let expected: BackupPayload
	switch (payload.kind) {
		case 'scheduled': {
			if (!hasExactDataKeys(payload, scheduledPayloadKeys)) {
				throw new BackupError(
					'invalid-workflow-payload',
					'scheduled workflow payload did not have exact fields',
				)
			}
			expected = backupPayload(env, canonicalScheduledDate(payload.scheduledAt))
			break
		}
		case 'mailbox-legacy-graph-pre-drop': {
			if (
				!hasExactDataKeys(payload, mailboxPreDropPayloadKeys) ||
				typeof payload.requestId !== 'string' ||
				typeof payload.nonce !== 'string' ||
				typeof payload.requestedAt !== 'string'
			) {
				throw new BackupError(
					'invalid-workflow-payload',
					'mailbox pre-drop workflow payload did not have exact fields',
				)
			}
			canonicalScheduledDate(payload.requestedAt)
			expected = mailboxPreDropRuntimePayload(env, {
				requestId: payload.requestId,
				nonce: payload.nonce,
				requestedAt: payload.requestedAt,
			})
			break
		}
		default:
			throw new BackupError(
				'invalid-workflow-payload-kind',
				'workflow payload kind is not approved for this Workflow',
			)
	}
	if (!matchesExpectedPayload(payload, expected)) {
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
		const checkedPayload = validatePayload(
			env,
			event.payload,
			options.payloadKind ?? 'scheduled',
		)
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
				const refreshedObjectKey = objectKeyForPayload(
					checkedPayload,
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
