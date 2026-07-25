import { sealedFullManifestKey } from '@kody-internal/shared/backup-staging.ts'

import { BackupError, backupPayload, safeLog } from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	awaitExportReady,
	startD1Export,
	type ApiOptions,
} from './d1-export-api.ts'
import { importSqlIntoD1 } from './d1-import-api.ts'
import { verifyBackupFullManifestSignature } from './full-manifest-signing.ts'
import { readManifest } from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { readFullManifest } from './seal-full-backup.ts'

export type DrRestoreChunkResponse = {
	done: boolean
	nextCursor?: string
	progress: unknown
	warnings: Array<string>
}

export type ProductionRestorePayload = {
	day: string
	requestedAt: string
}

export type ProductionRestoreProgressValue =
	| string
	| number
	| boolean
	| null
	| Array<string>
	| { [key: string]: string | number | boolean | null | Array<string> }

export type ProductionRestoreProgress = {
	day: string
	phase:
		| 'validating'
		| 'capturing-safety-export'
		| 'importing-d1'
		| 'restoring-stores'
		| 'complete'
		| 'failed'
	d1ImportComplete: boolean
	storeRestoreComplete: boolean
	storeIterations: number
	warnings: Array<string>
	safetyExportKey?: string
	safetyExportBytes?: number
	errorCode?: string
	errorMessage?: string
	progress?: ProductionRestoreProgressValue
}

const MAX_STORE_RESTORE_ITERATIONS = 500
const DEFAULT_SAFETY_EXPORT_POLLS = 120
const DEFAULT_SAFETY_EXPORT_POLL_DELAY_MS = 15_000

function serializeRestoreProgress(
	value: unknown,
): ProductionRestoreProgressValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value
	}
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === 'string')
	) {
		return value
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record: {
			[key: string]: string | number | boolean | null | Array<string>
		} = {}
		for (const [key, entry] of Object.entries(value)) {
			if (
				entry === null ||
				typeof entry === 'string' ||
				typeof entry === 'number' ||
				typeof entry === 'boolean'
			) {
				record[key] = entry
				continue
			}
			if (
				Array.isArray(entry) &&
				entry.every((item) => typeof item === 'string')
			) {
				record[key] = entry
			}
		}
		return record
	}
	return null
}

function requireDrRestoreSecret(env: BackupEnvironment): string {
	const secret = env.DR_RESTORE_SECRET?.trim()
	if (!secret) {
		throw new BackupError(
			'dr-restore-secret-missing',
			'DR_RESTORE_SECRET is required',
		)
	}
	return secret
}

function requirePrimaryOrigin(env: BackupEnvironment): string {
	const origin = env.PRIMARY_WORKER_ORIGIN?.trim()
	if (!origin) {
		throw new BackupError(
			'primary-worker-origin-missing',
			'PRIMARY_WORKER_ORIGIN is required',
		)
	}
	return origin.replace(/\/$/, '')
}

export function restoreWorkflowInstanceId(
	day: string,
	expiresAt: string,
): string {
	const safeExpires = expiresAt.replaceAll(':', '-').replaceAll('.', '-')
	return `dr-restore-${day}-${safeExpires}`
}

export async function validateSealedDayForRestore(
	env: BackupEnvironment,
	day: string,
): Promise<{
	fullManifestKey: string
	d1ManifestKey: string
	sqlObjectKey: string
	sqlBytes: number
	sqlSha256: string
	sqlR2Etag: string
}> {
	const fullManifestKey = sealedFullManifestKey(day)
	const fullManifest = await readFullManifest(
		env.BACKUP_BUCKET,
		fullManifestKey,
	)
	if (fullManifest === null) {
		throw new BackupError(
			'restore-full-manifest-missing',
			`sealed full manifest missing for ${day}`,
		)
	}
	if (!(await verifyBackupFullManifestSignature(env, fullManifest))) {
		throw new BackupError(
			'restore-full-manifest-signature-invalid',
			`sealed full manifest signature invalid for ${day}`,
		)
	}
	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	if (fullManifest.payload.d1ManifestKey !== d1Payload.manifestKey) {
		throw new BackupError(
			'restore-d1-manifest-key-mismatch',
			'full manifest D1 key does not match configured source',
		)
	}
	const d1Manifest = await readManifest(
		env.BACKUP_BUCKET,
		fullManifest.payload.d1ManifestKey,
	)
	if (d1Manifest === null) {
		throw new BackupError(
			'restore-d1-manifest-missing',
			`D1 manifest missing for ${day}`,
		)
	}
	if (!(await verifyBackupManifestSignature(env, d1Manifest))) {
		throw new BackupError(
			'restore-d1-manifest-signature-invalid',
			`D1 manifest signature invalid for ${day}`,
		)
	}
	return {
		fullManifestKey,
		d1ManifestKey: fullManifest.payload.d1ManifestKey,
		sqlObjectKey: d1Manifest.payload.sql.objectKey,
		sqlBytes: d1Manifest.payload.sql.bytes,
		sqlSha256: d1Manifest.payload.sql.sha256,
		sqlR2Etag: d1Manifest.payload.sql.r2Etag,
	}
}

export async function callProductionDrRestore(
	env: BackupEnvironment,
	input: { day: string; cursor?: string },
	options: ApiOptions = {},
): Promise<DrRestoreChunkResponse> {
	const fetcher = options.fetcher ?? fetch
	const origin = requirePrimaryOrigin(env)
	const secret = requireDrRestoreSecret(env)
	let response: Response
	try {
		response = await fetcher(`${origin}/__maintenance/dr-restore`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${secret}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				day: input.day,
				...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
			}),
		})
	} catch {
		throw new BackupError(
			'dr-restore-network-failure',
			'production dr-restore request failed',
			true,
		)
	}
	if (!response.ok) {
		throw new BackupError(
			'dr-restore-http-error',
			`production dr-restore returned HTTP ${response.status}`,
			response.status === 429 || response.status >= 500,
		)
	}
	const body = (await response.json()) as unknown
	if (
		!body ||
		typeof body !== 'object' ||
		Array.isArray(body) ||
		typeof (body as { done?: unknown }).done !== 'boolean' ||
		!Array.isArray((body as { warnings?: unknown }).warnings) ||
		!(body as { warnings: unknown[] }).warnings.every(
			(warning) => typeof warning === 'string',
		)
	) {
		throw new BackupError(
			'dr-restore-malformed',
			'production dr-restore response was invalid',
		)
	}
	const record = body as {
		done: boolean
		nextCursor?: unknown
		progress: unknown
		warnings: Array<string>
	}
	if (
		record.nextCursor !== undefined &&
		typeof record.nextCursor !== 'string'
	) {
		throw new BackupError(
			'dr-restore-malformed',
			'production dr-restore nextCursor was invalid',
		)
	}
	return {
		done: record.done,
		nextCursor:
			typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
		progress: record.progress,
		warnings: record.warnings,
	}
}

export async function capturePreRestoreSafetyExport(
	env: BackupEnvironment,
	day: string,
	now: Date = new Date(),
	options: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
	} = {},
): Promise<{ objectKey: string; bytes: number }> {
	const fetcher = options.fetcher ?? fetch
	const sleep =
		options.sleep ?? ((milliseconds) => scheduler.wait(milliseconds))
	const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_SAFETY_EXPORT_POLLS
	const pollDelayMs = options.pollDelayMs ?? DEFAULT_SAFETY_EXPORT_POLL_DELAY_MS

	const started = await startD1Export(env, options)
	const completed = await awaitExportReady(env, started, {
		...options,
		maxPollAttempts,
		pollDelayMs,
		earlyPollDelayMs: Math.min(pollDelayMs, 2_000),
		sleep,
	})

	let download: Response
	try {
		download = await fetcher(completed.signedUrl)
	} catch {
		throw new BackupError(
			'pre-restore-download-failed',
			'pre-restore safety export download failed',
			true,
		)
	}
	if (!download.ok || download.body === null) {
		throw new BackupError(
			'pre-restore-download-http-error',
			`pre-restore safety export download returned HTTP ${download.status}`,
			download.status === 429 || download.status >= 500,
		)
	}
	const contentLength = download.headers.get('content-length')
	const objectKey = `pre-restore/${day}/${now.toISOString()}.sql`
	if (contentLength !== null && /^\d+$/.test(contentLength)) {
		const bytes = Number(contentLength)
		if (!Number.isSafeInteger(bytes) || bytes <= 0) {
			throw new BackupError(
				'pre-restore-download-invalid-length',
				'pre-restore safety export Content-Length is invalid',
			)
		}
		await env.BACKUP_BUCKET.put(objectKey, download.body, {
			httpMetadata: { contentType: 'application/sql' },
		})
		return { objectKey, bytes }
	}
	// Some runtimes rewrite Content-Length on constructed Response bodies;
	// fall back to buffering so the safety snapshot still records exact bytes.
	const buffer = new Uint8Array(await download.arrayBuffer())
	if (buffer.byteLength === 0) {
		throw new BackupError(
			'pre-restore-download-empty',
			'pre-restore safety export download was empty',
			true,
		)
	}
	await env.BACKUP_BUCKET.put(objectKey, buffer, {
		httpMetadata: { contentType: 'application/sql' },
	})
	return { objectKey, bytes: buffer.byteLength }
}

export async function runProductionRestore(
	env: BackupEnvironment,
	payload: ProductionRestorePayload,
	options: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
		onProgress?: (progress: ProductionRestoreProgress) => Promise<void> | void
		now?: Date
	} = {},
): Promise<ProductionRestoreProgress> {
	const progress: ProductionRestoreProgress = {
		day: payload.day,
		phase: 'validating',
		d1ImportComplete: false,
		storeRestoreComplete: false,
		storeIterations: 0,
		warnings: [],
	}
	const publish = async () => {
		await options.onProgress?.(progress)
	}
	try {
		await publish()
		const validated = await validateSealedDayForRestore(env, payload.day)
		const sqlHead = await env.BACKUP_BUCKET.head(validated.sqlObjectKey)
		if (sqlHead === null) {
			throw new BackupError(
				'restore-sql-missing',
				`SQL object missing for ${payload.day}`,
			)
		}

		progress.phase = 'capturing-safety-export'
		await publish()
		safeLog({
			event: 'production-restore-safety-export-started',
			status: 'success',
			day: payload.day,
		})
		const safety = await capturePreRestoreSafetyExport(
			env,
			payload.day,
			options.now ?? new Date(),
			options,
		)
		progress.safetyExportKey = safety.objectKey
		progress.safetyExportBytes = safety.bytes
		await publish()
		safeLog({
			event: 'production-restore-safety-export-complete',
			status: 'success',
			day: payload.day,
			objectKey: safety.objectKey,
			bytes: safety.bytes,
		})

		progress.phase = 'importing-d1'
		await publish()
		safeLog({
			event: 'production-restore-d1-import-started',
			status: 'success',
			day: payload.day,
			objectKey: validated.sqlObjectKey,
		})
		await importSqlIntoD1({
			accountId: env.SOURCE_ACCOUNT_ID,
			databaseId: env.SOURCE_DATABASE_ID,
			token: env.CLOUDFLARE_API_TOKEN,
			sourceMd5Etag: validated.sqlR2Etag,
			loadSqlBody: async () => {
				const sqlObject = await env.BACKUP_BUCKET.get(validated.sqlObjectKey)
				if (sqlObject?.body == null) {
					throw new BackupError(
						'restore-sql-missing',
						`SQL object missing for ${payload.day}`,
					)
				}
				return sqlObject.body
			},
			options,
		})
		progress.d1ImportComplete = true
		progress.phase = 'restoring-stores'
		await publish()
		safeLog({
			event: 'production-restore-d1-import-complete',
			status: 'success',
			day: payload.day,
		})

		let cursor: string | undefined
		for (
			let iteration = 1;
			iteration <= MAX_STORE_RESTORE_ITERATIONS;
			iteration += 1
		) {
			progress.storeIterations = iteration
			const chunk = await callProductionDrRestore(
				env,
				{ day: payload.day, cursor },
				options,
			)
			progress.warnings.push(...chunk.warnings)
			progress.progress = serializeRestoreProgress(chunk.progress)
			await publish()
			if (chunk.done) {
				progress.storeRestoreComplete = true
				if (progress.warnings.length > 0) {
					progress.phase = 'failed'
					progress.errorCode = 'dr-restore-warnings'
					progress.errorMessage = `dr-restore completed with ${String(progress.warnings.length)} warning(s)`
					await publish()
					safeLog({
						event: 'production-restore-failure',
						status: 'failure',
						day: payload.day,
						errorCode: progress.errorCode,
					})
					return progress
				}
				progress.phase = 'complete'
				await publish()
				safeLog({
					event: 'production-restore-complete',
					status: 'success',
					day: payload.day,
				})
				return progress
			}
			cursor = chunk.nextCursor
			if (cursor === undefined) {
				throw new BackupError(
					'dr-restore-missing-cursor',
					'production dr-restore returned incomplete without nextCursor',
				)
			}
		}
		throw new BackupError(
			'dr-restore-iteration-budget',
			'production dr-restore exceeded iteration budget',
		)
	} catch (error) {
		progress.phase = 'failed'
		progress.errorCode =
			error instanceof BackupError ? error.code : 'unexpected-error'
		progress.errorMessage =
			error instanceof Error ? error.message : 'unexpected restore failure'
		await publish()
		safeLog({
			event: 'production-restore-failure',
			status: 'failure',
			day: payload.day,
			errorCode: progress.errorCode,
		})
		throw error
	}
}
