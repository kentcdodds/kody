import { generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import {
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	serializeBackupFullManifest,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from '@kody-internal/shared/backup-full-manifest.ts'
import {
	backupStagingSchemaVersion,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingMailboxDumpKey,
	type MailboxIndex,
} from '@kody-internal/shared/backup-staging.ts'
import {
	mailboxImportReplaceConfirmation,
	runMailboxImportTick,
} from '#worker/dr/mailbox-importer.ts'
import { handleMailboxImportRequest } from '#worker/dr/mailbox-import-maintenance.ts'
import {
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

const mailboxMocks = vi.hoisted(() => ({
	countMailbox: vi.fn(),
	inspectRestoreState: vi.fn(),
	beginRestore: vi.fn(),
	finalizeRestore: vi.fn(),
	readDrillResult: vi.fn(),
	completeDrill: vi.fn(),
	purge: vi.fn(),
	upsertMessageGraph: vi.fn(),
	upsertDeliveryEvents: vi.fn(),
}))

vi.mock('#worker/email/mailbox-client.ts', () => ({
	mailboxRpc: () => mailboxMocks,
}))

const emptyCounts = {
	threads: 0,
	messages: 0,
	attachments: 0,
	deliveryEvents: 0,
}
const threadCounts = {
	threads: 2,
	messages: 0,
	attachments: 0,
	deliveryEvents: 0,
}

function restoreStatus(counts: typeof emptyCounts, hiddenRows = 0) {
	return {
		counts,
		hiddenRows,
		restorePending: false,
		empty:
			hiddenRows === 0 && Object.values(counts).every((count) => count === 0),
	}
}

function createMemoryS3(seed: Record<string, string | Uint8Array>) {
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

async function createBackup(
	options: {
		indexDumpOwnerId?: string
		sealedAt?: string
		threadRowExtra?: Record<string, unknown>
	} = {},
) {
	const day = '2026-08-01'
	const ownerId = 'owner-a'
	const dump = ['thread-a', 'thread-b']
		.map((id) =>
			JSON.stringify({
				kind: 'thread',
				row: {
					id,
					inboxId: null,
					subjectNormalized: 'subject',
					rootMessageIdHeader: null,
					lastMessageAt: '2026-08-01T00:00:00.000Z',
					createdAt: '2026-08-01T00:00:00.000Z',
					updatedAt: '2026-08-01T00:00:00.000Z',
					...options.threadRowExtra,
				},
			}),
		)
		.map((line) => `${line}\n`)
		.join('')
	const dumpKey = stagingMailboxDumpKey(
		day,
		options.indexDumpOwnerId ?? ownerId,
	)
	const index: MailboxIndex = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: dumpKey,
				entryCount: 2,
				bytes: new TextEncoder().encode(dump).byteLength,
				sha256: await sha256Hex(dump),
			},
		],
	}
	const indexBody = JSON.stringify(index)
	const mailboxIndex = {
		objectKey: `${sealedFullPrefix(day)}mailbox-index.json`,
		bytes: new TextEncoder().encode(indexBody).byteLength,
		sha256: await sha256Hex(indexBody),
	}
	const keys = generateKeyPairSync('ed25519')
	const keyId = 'node-test-key'
	const payload: BackupFullManifestPayload = {
		schemaVersion: backupFullManifestSchemaVersion,
		day,
		d1ManifestKey: `daily/d1/${day}/manifest.json`,
		d1ManifestSha256: 'a'.repeat(64),
		mailboxIndex,
		runLogIndex: {
			objectKey: `${sealedFullPrefix(day)}run-log-index.json`,
			bytes: 0,
			sha256: 'b'.repeat(64),
		},
		storageIndex: {
			objectKey: `${sealedFullPrefix(day)}storage-index.json`,
			bytes: 0,
			sha256: 'c'.repeat(64),
		},
		r2Indexes: {},
		artifactsIndex: {
			objectKey: `${sealedFullPrefix(day)}artifacts-index.json`,
			bytes: 0,
			sha256: 'd'.repeat(64),
		},
		sealedAt: options.sealedAt ?? '2026-08-02T06:00:00.000Z',
		buildCommit: 'node-test',
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
		},
	}
	const manifest: BackupFullManifest = {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
			value: signBytes(
				null,
				Buffer.from(canonicalBackupFullManifestPayload(payload)),
				keys.privateKey,
			).toString('base64'),
		},
	}
	const s3 = createMemoryS3({
		[sealedFullManifestKey(day)]: serializeBackupFullManifest(manifest),
		[mailboxIndex.objectKey]: indexBody,
		[`${sealedFullPrefix(day)}mailbox/${encodeURIComponent(ownerId)}.ndjson`]:
			dump,
	})
	const env = {
		DR_RESTORE_SECRET: 'node-test-restore-secret',
		DR_BACKUP_ACCOUNT_ID: 'account',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'access',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		BACKUP_MANIFEST_SIGNING_KEY_ID: keyId,
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: keys.publicKey
			.export({ format: 'der', type: 'spki' })
			.toString('base64'),
	} as unknown as Env
	return { day, ownerId, dumpKey, manifest, mailboxIndex, s3, env }
}

function resetMailboxMocks() {
	mailboxMocks.countMailbox.mockReset()
	mailboxMocks.inspectRestoreState.mockReset()
	mailboxMocks.beginRestore.mockReset()
	mailboxMocks.finalizeRestore.mockReset()
	mailboxMocks.readDrillResult.mockReset()
	mailboxMocks.completeDrill.mockReset()
	mailboxMocks.purge.mockReset()
	mailboxMocks.upsertMessageGraph.mockReset()
	mailboxMocks.upsertDeliveryEvents.mockReset()
	mailboxMocks.purge.mockResolvedValue({ ok: true })
	mailboxMocks.inspectRestoreState.mockResolvedValue(restoreStatus(emptyCounts))
	mailboxMocks.finalizeRestore.mockResolvedValue({ ok: true })
	mailboxMocks.beginRestore.mockResolvedValue({ ok: true })
	mailboxMocks.readDrillResult.mockResolvedValue(null)
	mailboxMocks.completeDrill.mockResolvedValue({ ok: true })
	mailboxMocks.upsertMessageGraph.mockResolvedValue({
		ok: true,
		accepted: true,
	})
	mailboxMocks.upsertDeliveryEvents.mockResolvedValue({ results: [] })
}

test('mailbox import endpoint is secret-gated and replace needs exact confirmation', async () => {
	const missing = await handleMailboxImportRequest(
		new Request('https://example.com/__maintenance/dr-mailbox-import', {
			method: 'POST',
			body: JSON.stringify({ day: '2026-08-01', owners: ['owner-a'] }),
		}),
		{} as Env,
	)
	expect(missing.status).toBe(503)

	const wrong = await handleMailboxImportRequest(
		new Request('https://example.com/__maintenance/dr-mailbox-import', {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong' },
			body: JSON.stringify({ day: '2026-08-01', owners: ['owner-a'] }),
		}),
		{ DR_RESTORE_SECRET: 'correct' } as Env,
	)
	expect(wrong.status).toBe(401)

	const unconfirmed = await handleMailboxImportRequest(
		new Request('https://example.com/__maintenance/dr-mailbox-import', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer correct',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				day: '2026-08-01',
				owners: ['owner-a'],
				conflictPolicy: 'replace',
				replaceConfirmation: 'almost',
			}),
		}),
		{ DR_RESTORE_SECRET: 'correct' } as Env,
	)
	expect(unconfirmed.status).toBe(500)
	expect(await unconfirmed.json()).toMatchObject({
		ok: false,
		error: expect.stringContaining(mailboxImportReplaceConfirmation),
	})
})

test('mailbox importer verifies sealed media before writes', async () => {
	// Occupied-target and tampered-dump fail-closed paths are covered by the
	// workers DO workflow; keep node-only signature/schema guards here.
	const invalidSignature = await createBackup()
	const manifest = {
		...invalidSignature.manifest,
		signature: {
			...invalidSignature.manifest.signature,
			value: Buffer.alloc(64).toString('base64'),
		},
	}
	invalidSignature.s3.objects.set(
		sealedFullManifestKey(invalidSignature.day),
		new TextEncoder().encode(serializeBackupFullManifest(manifest)),
	)
	await expect(
		runMailboxImportTick({
			env: invalidSignature.env,
			day: invalidSignature.day,
			owners: [invalidSignature.ownerId],
			s3: invalidSignature.s3.client,
		}),
	).rejects.toThrow(/signature is invalid/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()

	const swappedOwnerKey = await createBackup({ indexDumpOwnerId: 'owner-b' })
	await expect(
		runMailboxImportTick({
			env: swappedOwnerKey.env,
			day: swappedOwnerKey.day,
			owners: [swappedOwnerKey.ownerId],
			s3: swappedOwnerKey.s3.client,
		}),
	).rejects.toThrow(/invalid owner entry/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()

	resetMailboxMocks()
	const unknownField = await createBackup({
		threadRowExtra: { unexpected: true },
	})
	await expect(
		runMailboxImportTick({
			env: unknownField.env,
			day: unknownField.day,
			owners: [unknownField.ownerId],
			s3: unknownField.s3.client,
		}),
	).rejects.toThrow(/missing or unknown fields/)
	expect(mailboxMocks.inspectRestoreState).not.toHaveBeenCalled()
})

test('mailbox importer rejects a cursor from a different sealed generation', async () => {
	resetMailboxMocks()
	const original = await createBackup()
	const first = await runMailboxImportTick({
		env: original.env,
		day: original.day,
		owners: [original.ownerId],
		timeBudgetMs: 0,
		s3: original.s3.client,
	})
	expect(first.nextCursor).toBeTruthy()

	const replacement = await createBackup({
		sealedAt: '2026-08-02T07:00:00.000Z',
	})
	original.s3.objects.clear()
	for (const [key, value] of replacement.s3.objects) {
		original.s3.objects.set(key, value)
	}
	await expect(
		runMailboxImportTick({
			env: replacement.env,
			day: replacement.day,
			owners: [replacement.ownerId],
			cursor: first.nextCursor,
			timeBudgetMs: 60_000,
			s3: original.s3.client,
		}),
	).rejects.toThrow(/cursor does not match this import request/)
})

test('drill cleanup stays idempotent across lost responses for success and mismatch', async () => {
	resetMailboxMocks()
	const backup = await createBackup()
	const now = vi
		.spyOn(Date, 'now')
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValue(2)
	const beforeVerify = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		drill: true,
		timeBudgetMs: 1,
		s3: backup.s3.client,
	})
	now.mockRestore()
	expect(beforeVerify.progress.phase).toBe('verify')

	mailboxMocks.countMailbox.mockResolvedValueOnce(threadCounts)
	const completed = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		drill: true,
		cursor: beforeVerify.nextCursor,
		timeBudgetMs: 60_000,
		s3: backup.s3.client,
	})
	expect(completed.verified).toBe(true)
	const cleanupCalls = mailboxMocks.completeDrill.mock.calls.length

	mailboxMocks.readDrillResult.mockResolvedValueOnce(threadCounts)
	const replayedSuccess = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		drill: true,
		cursor: beforeVerify.nextCursor,
		timeBudgetMs: 60_000,
		s3: backup.s3.client,
	})
	expect(replayedSuccess.verified).toBe(true)
	expect(mailboxMocks.completeDrill.mock.calls.length).toBe(cleanupCalls)

	resetMailboxMocks()
	const mismatchBackup = await createBackup()
	const mismatchNow = vi
		.spyOn(Date, 'now')
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValue(2)
	const mismatchBeforeVerify = await runMailboxImportTick({
		env: mismatchBackup.env,
		day: mismatchBackup.day,
		owners: [mismatchBackup.ownerId],
		drill: true,
		timeBudgetMs: 1,
		s3: mismatchBackup.s3.client,
	})
	mismatchNow.mockRestore()

	mailboxMocks.countMailbox.mockResolvedValueOnce(emptyCounts)
	const mismatch = await runMailboxImportTick({
		env: mismatchBackup.env,
		day: mismatchBackup.day,
		owners: [mismatchBackup.ownerId],
		drill: true,
		cursor: mismatchBeforeVerify.nextCursor,
		timeBudgetMs: 60_000,
		s3: mismatchBackup.s3.client,
	})
	expect(mismatch.verified).toBe(false)

	mailboxMocks.readDrillResult.mockResolvedValueOnce(emptyCounts)
	const replayedMismatch = await runMailboxImportTick({
		env: mismatchBackup.env,
		day: mismatchBackup.day,
		owners: [mismatchBackup.ownerId],
		drill: true,
		cursor: mismatchBeforeVerify.nextCursor,
		timeBudgetMs: 60_000,
		s3: mismatchBackup.s3.client,
	})
	expect(replayedMismatch.verified).toBe(false)
})

test('mailbox importer resumes replacement idempotently and reports count mismatch', async () => {
	resetMailboxMocks()
	const backup = await createBackup()
	mailboxMocks.inspectRestoreState
		.mockResolvedValueOnce(restoreStatus(threadCounts))
		.mockResolvedValueOnce(restoreStatus(emptyCounts))
		.mockResolvedValue(restoreStatus(threadCounts))
	mailboxMocks.countMailbox.mockResolvedValue(threadCounts)
	const now = vi
		.spyOn(Date, 'now')
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValue(2)
	const first = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		conflictPolicy: 'replace',
		replaceConfirmation: mailboxImportReplaceConfirmation,
		timeBudgetMs: 1,
		s3: backup.s3.client,
	})
	now.mockRestore()
	expect(first.done).toBe(false)
	expect(first.progress.phase).toBe('preflight-threads')
	expect(mailboxMocks.purge).not.toHaveBeenCalled()
	expect(mailboxMocks.upsertMessageGraph).toHaveBeenCalledTimes(1)

	const [payload, signature] = first.nextCursor!.split('.')
	const forgedPayload = btoa(
		JSON.stringify({
			...(JSON.parse(atob(payload!)) as Record<string, unknown>),
			phase: 'done',
			ownerIndex: 1,
			rowIndex: 0,
			ownersPassed: 1,
		}),
	)
	await expect(
		runMailboxImportTick({
			env: backup.env,
			day: backup.day,
			owners: [backup.ownerId],
			conflictPolicy: 'replace',
			replaceConfirmation: mailboxImportReplaceConfirmation,
			cursor: `${forgedPayload}.${signature}`,
			timeBudgetMs: 60_000,
			s3: backup.s3.client,
		}),
	).rejects.toThrow(/cursor signature is invalid/)

	const completed = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		conflictPolicy: 'replace',
		replaceConfirmation: mailboxImportReplaceConfirmation,
		cursor: first.nextCursor,
		timeBudgetMs: 60_000,
		s3: backup.s3.client,
	})
	expect(completed).toMatchObject({
		done: true,
		verified: true,
		progress: { ownersPassed: 1, ownersMismatched: 0, ownersReplaced: 1 },
	})
	expect(mailboxMocks.purge).toHaveBeenCalledWith({ ownerId: backup.ownerId })
	expect(mailboxMocks.upsertMessageGraph).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: backup.ownerId,
			thread: expect.objectContaining({ id: 'thread-b' }),
			message: null,
		}),
	)

	const replayed = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		conflictPolicy: 'replace',
		replaceConfirmation: mailboxImportReplaceConfirmation,
		cursor: first.nextCursor,
		timeBudgetMs: 60_000,
		s3: backup.s3.client,
	})
	expect(replayed.verified).toBe(true)

	resetMailboxMocks()
	const rejectedBackup = await createBackup()
	mailboxMocks.upsertMessageGraph.mockResolvedValue({
		ok: true,
		accepted: false,
	})
	await expect(
		runMailboxImportTick({
			env: rejectedBackup.env,
			day: rejectedBackup.day,
			owners: [rejectedBackup.ownerId],
			timeBudgetMs: 60_000,
			s3: rejectedBackup.s3.client,
		}),
	).rejects.toThrow(/rejected restored thread/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()

	resetMailboxMocks()
	const mismatchBackup = await createBackup()
	mailboxMocks.countMailbox.mockResolvedValue(emptyCounts)
	const mismatch = await runMailboxImportTick({
		env: mismatchBackup.env,
		day: mismatchBackup.day,
		owners: 'all-from-index',
		timeBudgetMs: 60_000,
		s3: mismatchBackup.s3.client,
	})
	expect(mismatch).toMatchObject({
		done: true,
		verified: false,
		progress: { ownersPassed: 0, ownersMismatched: 1 },
		ownerResults: [
			{
				sourceOwnerId: mismatchBackup.ownerId,
				expected: threadCounts,
				actual: emptyCounts,
				matches: false,
				drill: false,
			},
		],
		warnings: [expect.stringContaining('count mismatch')],
	})
})
