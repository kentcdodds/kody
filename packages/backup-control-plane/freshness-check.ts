import {
	MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
	readManifest,
} from './immutable-storage.ts'
import {
	verifySourceDatabaseIdentity,
	type ApiOptions,
} from './d1-export-api.ts'
import {
	BackupError,
	assertConfiguredIdentity,
	backupPayload,
	isBookmarkObjectKey,
	safeLog,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'

function latestExpectedDate(scheduledAt: Date): Date {
	const expected = new Date(scheduledAt)
	const beforeDailyBackup =
		scheduledAt.getUTCHours() < 2 ||
		(scheduledAt.getUTCHours() === 2 && scheduledAt.getUTCMinutes() < 15)
	if (beforeDailyBackup) {
		expected.setUTCDate(expected.getUTCDate() - 1)
	}
	return expected
}

export async function checkFreshness(
	env: BackupEnvironment,
	scheduledAt: Date,
	apiOptions: ApiOptions = {},
): Promise<boolean> {
	assertConfiguredIdentity(env)
	await verifySourceDatabaseIdentity(env, apiOptions)
	const payload = backupPayload(env, latestExpectedDate(scheduledAt))
	const maxAgeHours = Number(env.BACKUP_MAX_AGE_HOURS ?? '26')
	if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
		throw new BackupError(
			'invalid-max-age',
			'BACKUP_MAX_AGE_HOURS must be a positive number',
		)
	}
	let manifest
	try {
		manifest = await readManifest(env.BACKUP_BUCKET, payload.manifestKey)
	} catch (error) {
		if (error instanceof BackupError && error.code === 'manifest-corrupt') {
			safeLog({
				event: 'freshness-stale',
				status: 'stale-success',
				day: payload.day,
				manifestKey: payload.manifestKey,
				errorCode: error.code,
			})
			return false
		}
		throw error
	}
	let ageHours: number | undefined
	let stale = manifest === null
	if (manifest !== null) {
		const validObjectKey = isBookmarkObjectKey(
			payload.objectPrefix,
			manifest.objectKey,
		)
		const object = validObjectKey
			? await env.BACKUP_BUCKET.head(manifest.objectKey)
			: null
		ageHours =
			(scheduledAt.valueOf() - new Date(manifest.completedAt).valueOf()) /
			3_600_000
		stale =
			!Number.isFinite(ageHours) ||
			ageHours < 0 ||
			ageHours > maxAgeHours ||
			manifest.source.accountId.toLowerCase() !==
				env.SOURCE_ACCOUNT_ID.toLowerCase() ||
			manifest.source.accountName !== env.SOURCE_ACCOUNT_NAME ||
			manifest.source.databaseId.toLowerCase() !==
				env.SOURCE_DATABASE_ID.toLowerCase() ||
			manifest.source.databaseName !== env.SOURCE_DATABASE_NAME ||
			!validObjectKey ||
			manifest.bytes <= 0 ||
			!/^[0-9a-f]{64}$/.test(manifest.sha256) ||
			!manifest.r2Etag ||
			object === null ||
			(object !== null &&
				(object.size !== manifest.bytes ||
					object.size >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES ||
					object.etag !== manifest.r2Etag))
	}
	safeLog({
		event: stale ? 'freshness-stale' : 'freshness-success',
		status: stale ? 'stale-success' : 'success',
		day: payload.day,
		objectKey: manifest?.objectKey,
		manifestKey: payload.manifestKey,
		ageHours,
	})
	return !stale
}
