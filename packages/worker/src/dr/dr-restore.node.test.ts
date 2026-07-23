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
	__testOnlySealedObjectKey,
	handleDrRestoreRequest,
	runDrRestoreTick,
} from '#worker/dr/dr-restore.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import { type DrBackupS3Client } from '#worker/dr/backup-s3.ts'

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
			return { exists: objects.has(key), status: objects.has(key) ? 200 : 404 }
		},
		async getText(key) {
			const bytes = objects.get(key)
			return bytes ? new TextDecoder().decode(bytes) : null
		},
		async getBytes(key) {
			return objects.get(key) ?? null
		},
		async put(key, body) {
			objects.set(
				key,
				typeof body === 'string' ? new TextEncoder().encode(body) : body,
			)
		},
	}
	return { client, objects }
}

function sealedKey(day: string, stagingKey: string) {
	return __testOnlySealedObjectKey(day, stagingKey)
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
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
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
		COMMUNITY_ASSETS: {
			put: async () => {},
		},
		BUNDLE_ARTIFACTS_KV: {
			put: async (key: string, value: string) => {
				kvPuts.push({ key, value })
			},
		},
		STORAGE_RUNNER: {},
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

test('dr-restore records a warning when blob sha256 verification fails', async () => {
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
	const env = {
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		EMAIL_BLOBS: { put: async () => {} },
		COMMUNITY_ASSETS: { put: async () => {} },
		BUNDLE_ARTIFACTS_KV: { put: async () => {} },
		STORAGE_RUNNER: {},
	} as unknown as Env

	const result = await runDrRestoreTick({
		env,
		day,
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.done).toBe(true)
	expect(
		result.warnings.some((warning) => warning.includes('sha256 mismatch')),
	).toBe(true)
})

test('sealed object keys rewrite staging prefix into daily/full', () => {
	expect(sealedKey('2026-07-23', stagingStorageIndexKey('2026-07-23'))).toBe(
		`${sealedFullPrefix('2026-07-23')}storage-index.json`,
	)
})
