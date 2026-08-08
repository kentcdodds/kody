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
	handleMailboxImportRequest,
	mailboxImportReplaceConfirmation,
	runMailboxImportTick,
} from '#worker/dr/mailbox-importer.ts'
import {
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

const mailboxMocks = vi.hoisted(() => ({
	countMailbox: vi.fn(),
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
	threads: 1,
	messages: 0,
	attachments: 0,
	deliveryEvents: 0,
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

async function createBackup() {
	const day = '2026-08-01'
	const ownerId = 'owner-a'
	const dump = `${JSON.stringify({
		kind: 'thread',
		row: {
			id: 'thread-a',
			inboxId: null,
			subjectNormalized: 'subject',
			rootMessageIdHeader: null,
			lastMessageAt: '2026-08-01T00:00:00.000Z',
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:00.000Z',
		},
	})}\n`
	const dumpKey = stagingMailboxDumpKey(day, ownerId)
	const index: MailboxIndex = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: dumpKey,
				entryCount: 1,
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
		sealedAt: '2026-08-02T06:00:00.000Z',
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
	mailboxMocks.purge.mockReset()
	mailboxMocks.upsertMessageGraph.mockReset()
	mailboxMocks.upsertDeliveryEvents.mockReset()
	mailboxMocks.purge.mockResolvedValue({ ok: true })
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

test('mailbox importer verifies sealed media before writes and refuses occupied targets', async () => {
	resetMailboxMocks()
	const backup = await createBackup()
	mailboxMocks.countMailbox.mockResolvedValue(threadCounts)
	await expect(
		runMailboxImportTick({
			env: backup.env,
			day: backup.day,
			owners: [backup.ownerId],
			s3: backup.s3.client,
		}),
	).rejects.toThrow(/non-empty/)
	expect(mailboxMocks.purge).not.toHaveBeenCalled()
	expect(mailboxMocks.upsertMessageGraph).not.toHaveBeenCalled()

	resetMailboxMocks()
	mailboxMocks.countMailbox.mockResolvedValue(emptyCounts)
	backup.s3.objects.set(
		`${sealedFullPrefix(backup.day)}mailbox/${encodeURIComponent(backup.ownerId)}.ndjson`,
		new TextEncoder().encode('tampered\n'),
	)
	await expect(
		runMailboxImportTick({
			env: backup.env,
			day: backup.day,
			owners: [backup.ownerId],
			s3: backup.s3.client,
		}),
	).rejects.toThrow(/byte count mismatch|sha256 mismatch/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()
	expect(mailboxMocks.upsertMessageGraph).not.toHaveBeenCalled()

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
})

test('mailbox importer resumes replacement idempotently and reports count mismatch', async () => {
	resetMailboxMocks()
	const backup = await createBackup()
	mailboxMocks.countMailbox.mockResolvedValueOnce(threadCounts)
	const first = await runMailboxImportTick({
		env: backup.env,
		day: backup.day,
		owners: [backup.ownerId],
		conflictPolicy: 'replace',
		replaceConfirmation: mailboxImportReplaceConfirmation,
		timeBudgetMs: 0,
		s3: backup.s3.client,
	})
	expect(first.done).toBe(false)
	expect(first.progress.phase).toBe('threads')
	expect(mailboxMocks.purge).toHaveBeenCalledWith({ ownerId: backup.ownerId })
	expect(mailboxMocks.upsertMessageGraph).not.toHaveBeenCalled()

	mailboxMocks.countMailbox.mockResolvedValue(threadCounts)
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
	expect(mailboxMocks.purge).toHaveBeenCalledTimes(1)
	expect(mailboxMocks.upsertMessageGraph).toHaveBeenCalledWith({
		ownerId: backup.ownerId,
		thread: expect.objectContaining({ id: 'thread-a' }),
		message: null,
	})

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
	expect(mailboxMocks.purge).toHaveBeenCalledTimes(1)

	resetMailboxMocks()
	const mismatchBackup = await createBackup()
	mailboxMocks.countMailbox
		.mockResolvedValueOnce(emptyCounts)
		.mockResolvedValueOnce(emptyCounts)
	const mismatch = await runMailboxImportTick({
		env: mismatchBackup.env,
		day: mismatchBackup.day,
		owners: [mismatchBackup.ownerId],
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
