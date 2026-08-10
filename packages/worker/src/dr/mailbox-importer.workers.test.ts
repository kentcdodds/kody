import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
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
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import {
	type MailboxDeliveryEventRecord,
	type MailboxExportRow,
	type MailboxMessageRecord,
	type MailboxThreadRecord,
} from '#worker/email/mailbox-types.ts'
import {
	mailboxImportDrillOwnerPrefix,
	mailboxImportReplaceConfirmation,
	runMailboxImportTick,
} from '#worker/dr/mailbox-importer.ts'
import {
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

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

function message(ownerId: string): MailboxMessageRecord {
	return {
		id: 'restore-message',
		direction: 'inbound',
		inboxId: 'inbox-1',
		threadId: 'restore-thread',
		senderIdentityId: null,
		fromAddress: 'sender@example.com',
		envelopeFrom: 'sender@example.com',
		toAddresses: ['inbox@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Restored message',
		messageIdHeader: '<restore@example.com>',
		inReplyToHeader: null,
		references: [],
		headers: { from: 'sender@example.com' },
		authResults: null,
		textBody: 'restored',
		htmlBody: null,
		rawMimeKey: emailRawMimeKey(ownerId, 'restore-message'),
		rawSize: 8,
		processingStatus: 'stored',
		classification: 'accepted',
		classificationReason: null,
		providerMessageId: null,
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-08-01T01:02:03.000Z',
		error: null,
		receivedAt: '2026-08-01T01:02:03.000Z',
		sentAt: null,
		createdAt: '2026-08-01T01:02:03.000Z',
		updatedAt: '2026-08-01T01:02:04.000Z',
	}
}

function deliveryEvent(): MailboxDeliveryEventRecord {
	return {
		id: 'restore-event',
		messageId: 'restore-message',
		inboxId: 'inbox-1',
		eventType: 'delivered',
		provider: 'kody',
		providerMessageId: null,
		providerEventId: 'restore-provider-event',
		detailJson: '{}',
		needsEffectReconcile: false,
		state: null,
		fingerprint: null,
		storageLease: null,
		storageLeaseAt: null,
		cleanupLease: null,
		cleanupLeaseAt: null,
		cleanupRetryAt: null,
		expectedAttachmentCount: null,
		finalizationToken: null,
		reconcileAfter: null,
		dedupeExpiresAt: null,
		usageEffectRecordedAt: null,
		usageEffectSuppressedAt: null,
		usageStartedAt: null,
		usageMonth: null,
		usageBytes: null,
		usageDurationMs: null,
		usageEffectRetryAt: null,
		usageEffectLease: null,
		usageEffectLeaseAt: null,
		subscriptionEffectState: null,
		subscriptionEffectLease: null,
		subscriptionEffectLeaseAt: null,
		subscriptionEffectRetryAt: null,
		subscriptionEffectAttemptCount: null,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: '2026-08-01T01:02:05.000Z',
		updatedAt: '2026-08-01T01:02:05.000Z',
	}
}

async function createBackup(
	ownerId: string,
	day: string,
	options: { duplicateProviderEvent?: boolean } = {},
) {
	const thread: MailboxThreadRecord = {
		id: 'restore-thread',
		inboxId: 'inbox-1',
		subjectNormalized: 'restored message',
		rootMessageIdHeader: '<restore@example.com>',
		lastMessageAt: '2026-08-01T01:02:03.000Z',
		createdAt: '2026-08-01T01:02:03.000Z',
		updatedAt: '2026-08-01T01:02:04.000Z',
	}
	const rows: Array<MailboxExportRow> = [
		{ kind: 'thread', row: thread },
		{ kind: 'message', row: message(ownerId) },
		{
			kind: 'attachment',
			row: {
				id: 'restore-attachment',
				messageId: 'restore-message',
				filename: 'restore.txt',
				contentType: 'text/plain',
				contentId: null,
				disposition: 'attachment',
				size: 8,
				storageKind: 'external',
				storageKey: emailAttachmentBlobKey(
					ownerId,
					'restore-message',
					'restore-attachment',
				),
				createdAt: '2026-08-01T01:02:03.000Z',
			},
		},
		{ kind: 'delivery_event', row: deliveryEvent() },
	]
	if (options.duplicateProviderEvent) {
		rows.push({
			kind: 'delivery_event',
			row: { ...deliveryEvent(), id: 'restore-event-duplicate' },
		})
	}
	const dump = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
	const stagingDumpKey = stagingMailboxDumpKey(day, ownerId)
	const index: MailboxIndex = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: stagingDumpKey,
				entryCount: rows.length,
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
	const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify',
	])
	const keyId = 'workers-test-key'
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
		buildCommit: 'workers-test',
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
		},
	}
	const signature = await crypto.subtle.sign(
		backupFullManifestSignatureAlgorithm,
		keyPair.privateKey,
		new TextEncoder().encode(canonicalBackupFullManifestPayload(payload)),
	)
	const manifest: BackupFullManifest = {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
			value: btoa(String.fromCharCode(...new Uint8Array(signature))),
		},
	}
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey('spki', keyPair.publicKey),
	)
	return {
		s3: createMemoryS3({
			[sealedFullManifestKey(day)]: serializeBackupFullManifest(manifest),
			[mailboxIndex.objectKey]: indexBody,
			[`${sealedFullPrefix(day)}mailbox/${encodeURIComponent(ownerId)}.ndjson`]:
				dump,
		}),
		env: Object.assign(Object.create(env), {
			DR_RESTORE_SECRET: 'workers-test-restore-secret',
			BACKUP_MANIFEST_SIGNING_KEY_ID: keyId,
			BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: btoa(
				String.fromCharCode(...publicKey),
			),
		}) as Env,
		dumpKey: `${sealedFullPrefix(day)}mailbox/${encodeURIComponent(ownerId)}.ndjson`,
	}
}

test('Mailbox importer drills into scratch objects, resumes, and fails closed', async () => {
	silenceIncidentalRuntimeWarnings()
	const day = '2026-08-01'
	const ownerId = `workers-import-source-${crypto.randomUUID()}`
	const backup = await createBackup(ownerId, day)

	const first = await runMailboxImportTick({
		env: backup.env,
		day,
		owners: [ownerId],
		drill: true,
		timeBudgetMs: 0,
		s3: backup.s3.client,
	})
	expect(first.done).toBe(false)
	expect(first.nextCursor).toBeTruthy()
	expect(first.progress.phase).toBe('threads')

	const completed = await runMailboxImportTick({
		env: backup.env,
		day,
		owners: [ownerId],
		drill: true,
		cursor: first.nextCursor,
		timeBudgetMs: 60_000,
		s3: backup.s3.client,
	})
	expect(completed.done).toBe(true)
	expect(completed.verified).toBe(true)
	expect(completed.ownerResults).toEqual([
		expect.objectContaining({
			sourceOwnerId: ownerId,
			matches: true,
			drill: true,
		}),
	])

	const drillOwnerId = `${mailboxImportDrillOwnerPrefix}${day}:${encodeURIComponent(ownerId)}`
	const scratch = mailboxRpc({ env: backup.env, userId: drillOwnerId })
	expect(await scratch.countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
	expect(await scratch.getMessage({ messageId: 'restore-message' })).toBeNull()
	expect(await scratch.readDrillResult({ ownerId: drillOwnerId })).toEqual({
		threads: 1,
		messages: 1,
		attachments: 1,
		deliveryEvents: 1,
	})
	expect(
		await mailboxRpc({ env: backup.env, userId: ownerId }).countMailbox(),
	).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
	const scratchStub = backup.env.MAILBOX.get(
		backup.env.MAILBOX.idFromName(drillOwnerId),
	)
	await runInDurableObject(scratchStub, async (_instance, state) => {
		expect(await state.storage.getAlarm()).toBeNull()
	})

	const occupiedOwner = `workers-import-occupied-${crypto.randomUUID()}`
	const occupiedBackup = await createBackup(occupiedOwner, day)
	await mailboxRpc({
		env: occupiedBackup.env,
		userId: occupiedOwner,
	}).upsertMessageGraph({
		ownerId: occupiedOwner,
		message: {
			...message(occupiedOwner),
			id: 'existing-message',
			threadId: null,
			rawMimeKey: emailRawMimeKey(occupiedOwner, 'existing-message'),
		},
	})
	await expect(
		runMailboxImportTick({
			env: occupiedBackup.env,
			day,
			owners: [occupiedOwner],
			s3: occupiedBackup.s3.client,
		}),
	).rejects.toThrow(/non-empty/)
	expect(
		await mailboxRpc({
			env: occupiedBackup.env,
			userId: occupiedOwner,
		}).getMessage({ messageId: 'existing-message' }),
	).not.toBeNull()

	const replacementStarted = await runMailboxImportTick({
		env: occupiedBackup.env,
		day,
		owners: [occupiedOwner],
		conflictPolicy: 'replace',
		replaceConfirmation: mailboxImportReplaceConfirmation,
		timeBudgetMs: 0,
		s3: occupiedBackup.s3.client,
	})
	expect(replacementStarted.progress.phase).toBe('preflight-threads')
	expect(
		await mailboxRpc({
			env: occupiedBackup.env,
			userId: occupiedOwner,
		}).getMessage({ messageId: 'existing-message' }),
	).not.toBeNull()
	const preflightId = `__mailbox-import-preflight__:${day}:${encodeURIComponent(occupiedOwner)}`
	const preflightStub = occupiedBackup.env.MAILBOX.get(
		occupiedBackup.env.MAILBOX.idFromName(preflightId),
	)
	await runInDurableObject(preflightStub, async (_instance, state) => {
		expect(await state.storage.getAlarm()).toBeNull()
	})
	const replacementCompleted = await runMailboxImportTick({
		env: occupiedBackup.env,
		day,
		owners: [occupiedOwner],
		conflictPolicy: 'replace',
		replaceConfirmation: mailboxImportReplaceConfirmation,
		cursor: replacementStarted.nextCursor,
		timeBudgetMs: 60_000,
		s3: occupiedBackup.s3.client,
	})
	expect(replacementCompleted.verified).toBe(true)
	const replacedMailbox = mailboxRpc({
		env: occupiedBackup.env,
		userId: occupiedOwner,
	})
	expect(
		await replacedMailbox.getMessage({ messageId: 'existing-message' }),
	).toBeNull()
	expect(
		await replacedMailbox.getMessage({ messageId: 'restore-message' }),
	).not.toBeNull()
	const replacedStub = occupiedBackup.env.MAILBOX.get(
		occupiedBackup.env.MAILBOX.idFromName(occupiedOwner),
	)
	await runInDurableObject(replacedStub, async (_instance, state) => {
		expect(await state.storage.getAlarm()).not.toBeNull()
	})

	const invalidOwner = `workers-import-invalid-${crypto.randomUUID()}`
	const invalidBackup = await createBackup(invalidOwner, day, {
		duplicateProviderEvent: true,
	})
	const invalidTarget = mailboxRpc({
		env: invalidBackup.env,
		userId: invalidOwner,
	})
	await invalidTarget.upsertMessageGraph({
		ownerId: invalidOwner,
		message: {
			...message(invalidOwner),
			id: 'surviving-message',
			threadId: null,
			rawMimeKey: emailRawMimeKey(invalidOwner, 'surviving-message'),
		},
	})
	await expect(
		runMailboxImportTick({
			env: invalidBackup.env,
			day,
			owners: [invalidOwner],
			conflictPolicy: 'replace',
			replaceConfirmation: mailboxImportReplaceConfirmation,
			timeBudgetMs: 60_000,
			s3: invalidBackup.s3.client,
		}),
	).rejects.toThrow(/rejected restored delivery event/)
	expect(
		await invalidTarget.getMessage({ messageId: 'surviving-message' }),
	).not.toBeNull()

	const corruptOwner = `workers-import-corrupt-${crypto.randomUUID()}`
	const corruptBackup = await createBackup(corruptOwner, day)
	corruptBackup.s3.objects.set(
		corruptBackup.dumpKey,
		new TextEncoder().encode('tampered\n'),
	)
	await expect(
		runMailboxImportTick({
			env: corruptBackup.env,
			day,
			owners: [corruptOwner],
			drill: true,
			s3: corruptBackup.s3.client,
		}),
	).rejects.toThrow(/byte count mismatch|sha256 mismatch/)
	const corruptDrillOwner = `${mailboxImportDrillOwnerPrefix}${day}:${encodeURIComponent(corruptOwner)}`
	expect(
		await mailboxRpc({
			env: corruptBackup.env,
			userId: corruptDrillOwner,
		}).countMailbox(),
	).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})

	const tombstoneOwner = `workers-import-tombstone-${crypto.randomUUID()}`
	const tombstoneBackup = await createBackup(tombstoneOwner, day)
	const tombstoneMailbox = mailboxRpc({
		env: tombstoneBackup.env,
		userId: tombstoneOwner,
	})
	await tombstoneMailbox.tombstoneMissingMessage({
		ownerId: tombstoneOwner,
		messageId: 'restore-message',
		deletedAt: '2026-08-03T00:00:00.000Z',
	})
	expect(await tombstoneMailbox.countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
	await expect(
		runMailboxImportTick({
			env: tombstoneBackup.env,
			day,
			owners: [tombstoneOwner],
			s3: tombstoneBackup.s3.client,
		}),
	).rejects.toThrow(/non-empty/)
})
