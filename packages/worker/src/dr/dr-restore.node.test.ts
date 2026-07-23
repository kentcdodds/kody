import { expect, test, vi } from 'vitest'
import {
	backupBlobKey,
	sealedFullPrefix,
	stagingArtifactsIndexKey,
	stagingR2IndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	type ArtifactsIndex,
	type StorageIndex,
} from '@kody-internal/shared/backup-staging.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	__testOnlyDecodeCursor,
	__testOnlyEncodeCursor,
	__testOnlySealedObjectKey,
	handleDrRestoreRequest,
	runDrRestoreTick,
} from '#worker/dr/dr-restore.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import {
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { MaintenanceFailureError } from '#worker/maintenance-handler.ts'

const storageMocks = vi.hoisted(() => ({
	importStorage: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		importStorage: storageMocks.importStorage,
	}),
}))

function createMemoryS3(seed: Record<string, string | Uint8Array> = {}) {
	const objects = new Map<string, Uint8Array>()
	for (const [key, value] of Object.entries(seed)) {
		objects.set(
			key,
			typeof value === 'string' ? new TextEncoder().encode(value) : value,
		)
	}
	const client: DrBackupS3Client = {
		async head(key) {
			return {
				exists: objects.has(key),
				status: objects.has(key) ? 200 : 404,
				etag: objects.has(key) ? '"etag"' : null,
			}
		},
		async getText(key) {
			const bytes = objects.get(key)
			return bytes
				? { text: new TextDecoder().decode(bytes), etag: '"etag"' }
				: null
		},
		async getBytes(key) {
			return objects.get(key) ?? null
		},
		async put(key, body, _options?: DrBackupS3PutOptions) {
			objects.set(
				key,
				typeof body === 'string' ? new TextEncoder().encode(body) : body,
			)
			return { etag: '"etag"' }
		},
	}
	return { client, objects }
}

function sealedKey(day: string, stagingKey: string) {
	return __testOnlySealedObjectKey(day, stagingKey)
}

function baseEnv() {
	return {
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		EMAIL_BLOBS: { put: async () => {} },
		COMMUNITY_ASSETS: { put: async () => {} },
		BUNDLE_ARTIFACTS_KV: { put: async () => {} },
		STORAGE_RUNNER: {},
	} as unknown as Env
}

test('dr-restore auth fails closed when secret is missing and rejects wrong bearer', async () => {
	const missing = await handleDrRestoreRequest(
		new Request('https://example.com/__maintenance/dr-restore', {
			method: 'POST',
			body: JSON.stringify({ day: '2026-07-23' }),
		}),
		{} as Env,
	)
	expect(missing.status).toBe(503)

	const wrong = await handleDrRestoreRequest(
		new Request('https://example.com/__maintenance/dr-restore', {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong' },
			body: JSON.stringify({ day: '2026-07-23' }),
		}),
		{ DR_RESTORE_SECRET: 'correct' } as Env,
	)
	expect(wrong.status).toBe(401)
})

test('dr-restore restores storage, R2, and artifacts in chunked ticks', async () => {
	storageMocks.importStorage.mockReset()
	storageMocks.importStorage.mockResolvedValue({
		ok: true,
		written: 1,
		cleared: true,
	})

	const day = '2026-07-23'
	const identity = encodeStorageIdentity('user-a', 'job:1')
	const dumpBody = `${JSON.stringify({ key: 'alpha', valueJson: '{"n":1}' })}\n`
	const storageIndex: StorageIndex = {
		schemaVersion: 1,
		day,
		entries: [
			{
				storageId: identity,
				objectKey: stagingStorageDumpKey(day, identity),
				entryCount: 1,
				bytes: dumpBody.length,
				sha256: await sha256Hex(dumpBody),
			},
		],
	}
	const r2Bytes = new TextEncoder().encode('mime')
	const r2Digest = await sha256Hex(r2Bytes)
	const r2Index = `${JSON.stringify({ key: 'raw/1', size: r2Bytes.byteLength, sha256: r2Digest })}\n`
	const snapshot = JSON.stringify({ version: 1, files: { a: 'b' } })
	const snapshotDigest = await sha256Hex(snapshot)
	const artifactsIndex: ArtifactsIndex = {
		schemaVersion: 1,
		day,
		entries: [
			{
				sourceId: 'src-1',
				entityKind: 'package',
				entityId: 'pkg-1',
				userId: 'user-a',
				publishedCommit: 'commit-1',
				snapshotSha256: snapshotDigest,
			},
		],
	}

	const { client } = createMemoryS3({
		[sealedKey(day, stagingStorageIndexKey(day))]: JSON.stringify(storageIndex),
		[sealedKey(day, stagingStorageDumpKey(day, identity))]: dumpBody,
		[sealedKey(day, stagingR2IndexKey(day, 'email-blobs'))]: r2Index,
		[sealedKey(day, stagingR2IndexKey(day, 'community-assets'))]: '',
		[sealedKey(day, stagingArtifactsIndexKey(day))]:
			JSON.stringify(artifactsIndex),
		[backupBlobKey(r2Digest)]: r2Bytes,
		[backupBlobKey(snapshotDigest)]: snapshot,
	})

	const r2Puts: Array<{ key: string; bytes: Uint8Array }> = []
	const kvPuts: Array<{ key: string; value: string }> = []
	const env = {
		...baseEnv(),
		EMAIL_BLOBS: {
			put: async (key: string, value: ArrayBuffer | Uint8Array | string) => {
				const bytes =
					typeof value === 'string'
						? new TextEncoder().encode(value)
						: value instanceof Uint8Array
							? value
							: new Uint8Array(value)
				r2Puts.push({ key, bytes })
			},
		},
		BUNDLE_ARTIFACTS_KV: {
			put: async (key: string, value: string) => {
				kvPuts.push({ key, value })
			},
		},
	} as unknown as Env

	const first = await runDrRestoreTick({
		env,
		day,
		timeBudgetMs: 0,
		s3: client,
	})
	expect(first.done).toBe(false)
	expect(first.nextCursor).toBeTruthy()

	const second = await runDrRestoreTick({
		env,
		day,
		cursor: first.nextCursor,
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(second.done).toBe(true)
	expect(storageMocks.importStorage).toHaveBeenCalled()
	expect(r2Puts.some((entry) => entry.key === 'raw/1')).toBe(true)
	expect(
		kvPuts.some((entry) => entry.key === 'source-snapshot:v1:src-1:commit-1'),
	).toBe(true)
})

test('dr-restore hard-fails on missing storage dump listed in the index', async () => {
	const day = '2026-07-23'
	const identity = encodeStorageIdentity('user-a', 'job:1')
	const storageIndex: StorageIndex = {
		schemaVersion: 1,
		day,
		entries: [
			{
				storageId: identity,
				objectKey: stagingStorageDumpKey(day, identity),
				entryCount: 1,
				bytes: 1,
				sha256: 'a'.repeat(64),
			},
		],
	}
	const { client } = createMemoryS3({
		[sealedKey(day, stagingStorageIndexKey(day))]: JSON.stringify(storageIndex),
	})
	await expect(
		runDrRestoreTick({
			env: baseEnv(),
			day,
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).rejects.toBeInstanceOf(MaintenanceFailureError)
})

test('dr-restore hard-fails on blob sha256 verification failure', async () => {
	storageMocks.importStorage.mockReset()
	storageMocks.importStorage.mockResolvedValue({
		ok: true,
		written: 0,
		cleared: true,
	})
	const day = '2026-07-23'
	const badDigest = 'a'.repeat(64)
	const r2Index = `${JSON.stringify({ key: 'raw/bad', size: 4, sha256: badDigest })}\n`
	const storageIndex: StorageIndex = {
		schemaVersion: 1,
		day,
		entries: [],
	}
	const artifactsIndex: ArtifactsIndex = {
		schemaVersion: 1,
		day,
		entries: [],
	}
	const { client } = createMemoryS3({
		[sealedKey(day, stagingStorageIndexKey(day))]: JSON.stringify(storageIndex),
		[sealedKey(day, stagingR2IndexKey(day, 'email-blobs'))]: r2Index,
		[sealedKey(day, stagingR2IndexKey(day, 'community-assets'))]: '',
		[sealedKey(day, stagingArtifactsIndexKey(day))]:
			JSON.stringify(artifactsIndex),
		[backupBlobKey(badDigest)]: new TextEncoder().encode('nope'),
	})

	await expect(
		runDrRestoreTick({
			env: baseEnv(),
			day,
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).rejects.toMatchObject({
		name: 'MaintenanceFailureError',
		message: expect.stringContaining('sha256 mismatch'),
	})
})

test('dr-restore hard-fails on missing blob referenced by an index entry', async () => {
	const day = '2026-07-23'
	const missingDigest = 'b'.repeat(64)
	const artifactsIndex: ArtifactsIndex = {
		schemaVersion: 1,
		day,
		entries: [
			{
				sourceId: 'src-1',
				entityKind: 'package',
				entityId: 'pkg-1',
				userId: 'user-a',
				publishedCommit: 'commit-1',
				snapshotSha256: missingDigest,
			},
		],
	}
	const { client } = createMemoryS3({
		[sealedKey(day, stagingStorageIndexKey(day))]: JSON.stringify({
			schemaVersion: 1,
			day,
			entries: [],
		} satisfies StorageIndex),
		[sealedKey(day, stagingR2IndexKey(day, 'email-blobs'))]: '',
		[sealedKey(day, stagingR2IndexKey(day, 'community-assets'))]: '',
		[sealedKey(day, stagingArtifactsIndexKey(day))]:
			JSON.stringify(artifactsIndex),
	})

	await expect(
		runDrRestoreTick({
			env: baseEnv(),
			day,
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).rejects.toMatchObject({
		name: 'MaintenanceFailureError',
		message: expect.stringContaining('backup blob missing'),
	})
})

test('decodeCursor rejects NaN, negative, and non-safe-integer fields', () => {
	expect(() =>
		__testOnlyDecodeCursor(
			__testOnlyEncodeCursor({
				phase: 'storage',
				storageIndex: -1,
				storageLineOffset: 0,
				storageReplaceStarted: false,
				storageDumpVerified: false,
				r2LabelIndex: 0,
				r2LineOffset: 0,
				artifactsIndex: 0,
			}),
		),
	).toThrow(MaintenanceFailureError)

	expect(() =>
		__testOnlyDecodeCursor(
			btoa(
				JSON.stringify({
					phase: 'storage',
					storageIndex: '1',
					storageLineOffset: 0,
					storageReplaceStarted: false,
					storageDumpVerified: false,
					r2LabelIndex: 0,
					r2LineOffset: 0,
					artifactsIndex: 0,
				}),
			),
		),
	).toThrow(MaintenanceFailureError)

	expect(() =>
		__testOnlyDecodeCursor(
			btoa(
				JSON.stringify({
					phase: 'storage',
					storageIndex: 1.5,
					storageLineOffset: 0,
					storageReplaceStarted: false,
					storageDumpVerified: false,
					r2LabelIndex: 0,
					r2LineOffset: 0,
					artifactsIndex: 0,
				}),
			),
		),
	).toThrow(MaintenanceFailureError)
})

test('dr-restore hard-fails on storage dump sha256 mismatch before import', async () => {
	storageMocks.importStorage.mockReset()
	const day = '2026-07-23'
	const identity = encodeStorageIdentity('user-a', 'job:1')
	const dumpBody = `${JSON.stringify({ key: 'alpha', valueJson: '{"n":1}' })}\n`
	const storageIndex: StorageIndex = {
		schemaVersion: 1,
		day,
		entries: [
			{
				storageId: identity,
				objectKey: stagingStorageDumpKey(day, identity),
				entryCount: 1,
				bytes: dumpBody.length,
				sha256: 'c'.repeat(64),
			},
		],
	}
	const { client } = createMemoryS3({
		[sealedKey(day, stagingStorageIndexKey(day))]: JSON.stringify(storageIndex),
		[sealedKey(day, stagingStorageDumpKey(day, identity))]: dumpBody,
	})

	await expect(
		runDrRestoreTick({
			env: baseEnv(),
			day,
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).rejects.toMatchObject({
		name: 'MaintenanceFailureError',
		message: expect.stringContaining('storage dump sha256 mismatch'),
	})
	expect(storageMocks.importStorage).not.toHaveBeenCalled()
})

test('sealed object keys rewrite staging prefix into daily/full', () => {
	expect(sealedKey('2026-07-23', stagingStorageIndexKey('2026-07-23'))).toBe(
		`${sealedFullPrefix('2026-07-23')}storage-index.json`,
	)
})
