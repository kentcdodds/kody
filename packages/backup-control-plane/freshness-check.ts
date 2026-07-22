import { readManifest } from './immutable-storage.ts'
import {
	BackupError,
	assertConfiguredIdentity,
	backupPayload,
	safeLog,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'

function latestExpectedDate(scheduledAt: Date): Date {
	const expected = new Date(scheduledAt)
	if (scheduledAt.getUTCHours() < 3) {
		expected.setUTCDate(expected.getUTCDate() - 1)
	}
	return expected
}

export async function checkFreshness(
	env: BackupEnvironment,
	scheduledAt: Date,
): Promise<boolean> {
	assertConfiguredIdentity(env)
	const payload = backupPayload(env, latestExpectedDate(scheduledAt))
	const maxAgeHours = Number(env.BACKUP_MAX_AGE_HOURS ?? '26')
	if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
		throw new BackupError(
			'invalid-max-age',
			'BACKUP_MAX_AGE_HOURS must be a positive number',
		)
	}
	const manifest = await readManifest(env.BACKUP_BUCKET, payload.manifestKey)
	let ageHours: number | undefined
	let stale = manifest === null
	if (manifest !== null) {
		ageHours =
			(scheduledAt.valueOf() - new Date(manifest.completedAt).valueOf()) /
			3_600_000
		stale =
			!Number.isFinite(ageHours) ||
			ageHours < 0 ||
			ageHours > maxAgeHours ||
			manifest.source.accountId !== env.SOURCE_ACCOUNT_ID ||
			manifest.source.accountName !== env.SOURCE_ACCOUNT_NAME ||
			manifest.source.databaseId !== env.SOURCE_DATABASE_ID ||
			manifest.source.databaseName !== env.SOURCE_DATABASE_NAME ||
			manifest.objectKey !== payload.objectKey ||
			manifest.bytes <= 0 ||
			!/^[0-9a-f]{64}$/.test(manifest.sha256) ||
			!manifest.r2Etag ||
			(await env.BACKUP_BUCKET.head(payload.objectKey)) === null
	}
	safeLog({
		event: stale ? 'freshness-stale' : 'freshness-success',
		status: stale ? 'stale-success' : 'success',
		day: payload.day,
		objectKey: payload.objectKey,
		manifestKey: payload.manifestKey,
		ageHours,
	})
	return !stale
}
