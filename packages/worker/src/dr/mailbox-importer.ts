import {
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	parseBackupFullManifest,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from '@kody-internal/shared/backup-full-manifest.ts'
import {
	assertBackupDay,
	backupStagingSchemaVersion,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingPrefix,
	type MailboxIndex,
	type OwnerIndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import {
	mailboxUpsertDeliveryEventsMax,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxCountResult,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportRow,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from '#worker/email/mailbox-types.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from '#worker/maintenance-handler.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

export const mailboxImportRunTimeBudgetMs = 20_000
export const mailboxImportReplaceConfirmation =
	'PURGE NON-EMPTY TARGET MAILBOXES'
export const mailboxImportDrillOwnerPrefix = '__mailbox-drill__:'

const mailboxImportCursorVersion = 1 as const
const sha256Pattern = /^[0-9a-f]{64}$/
const base64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

type MailboxImportPhase =
	| 'prepare'
	| 'threads'
	| 'messages'
	| 'delivery-events'
	| 'verify'
	| 'done'

export type MailboxImportOwnerSelection = 'all-from-index' | Array<string>
export type MailboxImportConflictPolicy = 'refuse' | 'replace'

type MailboxImportCursor = {
	version: typeof mailboxImportCursorVersion
	day: string
	requestFingerprint: string
	ownerIndex: number
	phase: MailboxImportPhase
	rowIndex: number
	ownersPassed: number
	ownersMismatched: number
	ownersReplaced: number
}

export type MailboxImportOwnerResult = {
	sourceOwnerId: string
	targetOwnerId: string
	expected: MailboxCountResult
	actual: MailboxCountResult
	matches: boolean
	drill: boolean
}

export type MailboxImportTickResult = {
	done: boolean
	verified: boolean
	nextCursor?: string
	progress: {
		day: string
		phase: MailboxImportPhase
		ownerIndex: number
		totalOwners: number
		ownersPassed: number
		ownersMismatched: number
		ownersReplaced: number
		rowsProcessed: number
	}
	ownerResults: Array<MailboxImportOwnerResult>
	warnings: Array<string>
}

type ParsedMailboxDump = {
	threads: Array<MailboxThreadRecord>
	messages: Array<MailboxMessageRecord>
	attachmentsByMessage: Map<string, Array<MailboxAttachmentRecord>>
	deliveryEvents: Array<MailboxDeliveryEventRecord>
	counts: MailboxCountResult
}

type SignatureConfiguration = {
	keyId: string
	publicKeySpkiBase64: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function failure(
	message: string,
	progress: MailboxImportTickResult['progress'] | null = null,
): MaintenanceFailureError {
	return new MaintenanceFailureError(message, { progress, warnings: [] })
}

function requireExactNonEmptyString(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value !== value.trim()
	) {
		throw failure(`${field} must be an exact non-empty string`)
	}
	return value
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw failure(`invalid cursor field ${field}`)
	}
	return value
}

function readSignatureConfiguration(env: Env): SignatureConfiguration {
	const values = env as unknown as {
		BACKUP_MANIFEST_SIGNING_KEY_ID?: string
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64?: string
	}
	const keyId = values.BACKUP_MANIFEST_SIGNING_KEY_ID?.trim()
	const publicKeySpkiBase64 =
		values.BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64?.trim()
	if (!keyId || !publicKeySpkiBase64) {
		throw failure('Mailbox import manifest verification is not configured')
	}
	return { keyId, publicKeySpkiBase64 }
}

function decodeBase64(value: string, field: string): ArrayBuffer {
	if (!base64Pattern.test(value)) {
		throw failure(`${field} must be canonical base64`)
	}
	const binary = atob(value)
	return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
}

async function verifyFullManifestSignature(
	manifest: BackupFullManifest,
	configuration: SignatureConfiguration,
): Promise<boolean> {
	if (
		manifest.schemaVersion !== backupFullManifestSchemaVersion ||
		manifest.payload.schemaVersion !== backupFullManifestSchemaVersion ||
		manifest.payload.signing.keyId !== configuration.keyId ||
		manifest.signature.keyId !== configuration.keyId ||
		manifest.payload.signing.algorithm !==
			backupFullManifestSignatureAlgorithm ||
		manifest.signature.algorithm !== backupFullManifestSignatureAlgorithm
	) {
		return false
	}
	try {
		const publicKey = await crypto.subtle.importKey(
			'spki',
			decodeBase64(
				configuration.publicKeySpkiBase64,
				'manifest verifying public key',
			),
			backupFullManifestSignatureAlgorithm,
			false,
			['verify'],
		)
		return await crypto.subtle.verify(
			backupFullManifestSignatureAlgorithm,
			publicKey,
			decodeBase64(manifest.signature.value, 'full manifest signature'),
			new TextEncoder().encode(
				canonicalBackupFullManifestPayload(manifest.payload),
			),
		)
	} catch {
		return false
	}
}

function decodeUtf8(bytes: Uint8Array, field: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw failure(`${field} is not valid UTF-8`)
	}
}

async function getRequiredBytes(
	s3: DrBackupS3Client,
	key: string,
	description: string,
): Promise<Uint8Array> {
	const bytes = await s3.getBytes(key)
	if (!bytes) throw failure(`${description} missing at ${key}`)
	return bytes
}

async function verifyFileBytes(
	bytes: Uint8Array,
	expected: { bytes: number; sha256: string },
	description: string,
): Promise<void> {
	if (bytes.byteLength !== expected.bytes) {
		throw failure(
			`${description} byte count mismatch: expected ${expected.bytes}, got ${bytes.byteLength}`,
		)
	}
	const actualSha256 = await sha256Hex(bytes)
	if (actualSha256 !== expected.sha256) {
		throw failure(
			`${description} sha256 mismatch: expected ${expected.sha256}, got ${actualSha256}`,
		)
	}
}

function parseMailboxIndex(value: unknown, day: string): MailboxIndex {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupStagingSchemaVersion ||
		value.day !== day ||
		!Array.isArray(value.entries)
	) {
		throw failure('sealed mailbox index has an invalid versioned shape')
	}
	const ownerIds = new Set<string>()
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.ownerId !== 'string' ||
			entry.ownerId.length === 0 ||
			entry.ownerId !== entry.ownerId.trim() ||
			typeof entry.objectKey !== 'string' ||
			!entry.objectKey.startsWith(stagingPrefix(day)) ||
			!Number.isSafeInteger(entry.entryCount) ||
			Number(entry.entryCount) < 0 ||
			!Number.isSafeInteger(entry.bytes) ||
			Number(entry.bytes) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!sha256Pattern.test(entry.sha256) ||
			ownerIds.has(entry.ownerId)
		) {
			throw failure('sealed mailbox index contains an invalid owner entry')
		}
		ownerIds.add(entry.ownerId)
	}
	return value as MailboxIndex
}

function sealedDumpKey(day: string, stagingKey: string): string {
	const prefix = stagingPrefix(day)
	if (!stagingKey.startsWith(prefix)) {
		throw failure(`mailbox dump key is outside ${prefix}`)
	}
	return `${sealedFullPrefix(day)}${stagingKey.slice(prefix.length)}`
}

async function loadVerifiedMailboxIndex(input: {
	s3: DrBackupS3Client
	env: Env
	day: string
}): Promise<MailboxIndex> {
	const manifestBytes = await getRequiredBytes(
		input.s3,
		sealedFullManifestKey(input.day),
		'sealed full manifest',
	)
	let manifest: BackupFullManifest
	try {
		manifest = parseBackupFullManifest(
			JSON.parse(decodeUtf8(manifestBytes, 'sealed full manifest')) as unknown,
		)
	} catch (error) {
		if (error instanceof MaintenanceFailureError) throw error
		throw failure(`sealed full manifest is invalid: ${getErrorMessage(error)}`)
	}
	if (
		manifest.schemaVersion !== backupFullManifestSchemaVersion ||
		manifest.payload.day !== input.day
	) {
		throw failure('sealed full manifest does not cover the requested day')
	}
	if (
		!(await verifyFullManifestSignature(
			manifest,
			readSignatureConfiguration(input.env),
		))
	) {
		throw failure('sealed full manifest signature is invalid')
	}
	const payload = manifest.payload as BackupFullManifestPayload
	if (!payload.mailboxIndex.objectKey.startsWith(sealedFullPrefix(input.day))) {
		throw failure('sealed mailbox index key is outside the requested day')
	}
	const indexBytes = await getRequiredBytes(
		input.s3,
		payload.mailboxIndex.objectKey,
		'sealed mailbox index',
	)
	await verifyFileBytes(
		indexBytes,
		payload.mailboxIndex,
		'sealed mailbox index',
	)
	try {
		return parseMailboxIndex(
			JSON.parse(decodeUtf8(indexBytes, 'sealed mailbox index')) as unknown,
			input.day,
		)
	} catch (error) {
		if (error instanceof MaintenanceFailureError) throw error
		throw failure(`sealed mailbox index is invalid: ${getErrorMessage(error)}`)
	}
}

function parseDumpRow(value: unknown): MailboxExportRow {
	if (!isRecord(value) || !isRecord(value.row)) {
		throw failure('mailbox dump contains an invalid row')
	}
	switch (value.kind) {
		case 'thread':
		case 'message':
		case 'attachment':
		case 'delivery_event':
			return value as MailboxExportRow
		default:
			throw failure('mailbox dump contains an unknown row kind')
	}
}

function parseMailboxDump(text: string, entryCount: number): ParsedMailboxDump {
	const lines = text.length === 0 ? [] : text.split('\n')
	if (lines.at(-1) === '') lines.pop()
	const rows = lines.map((line) => {
		try {
			return parseDumpRow(JSON.parse(line) as unknown)
		} catch (error) {
			if (error instanceof MaintenanceFailureError) throw error
			throw failure(
				`mailbox dump contains invalid NDJSON: ${getErrorMessage(error)}`,
			)
		}
	})
	if (rows.length !== entryCount) {
		throw failure(
			`mailbox dump entry count mismatch: expected ${entryCount}, got ${rows.length}`,
		)
	}

	const threads: Array<MailboxThreadRecord> = []
	const messages: Array<MailboxMessageRecord> = []
	const attachments: Array<MailboxAttachmentRecord> = []
	const deliveryEvents: Array<MailboxDeliveryEventRecord> = []
	const idsByKind = {
		thread: new Set<string>(),
		message: new Set<string>(),
		attachment: new Set<string>(),
		delivery_event: new Set<string>(),
	}
	for (const row of rows) {
		const id = row.row.id
		if (
			typeof id !== 'string' ||
			id.length === 0 ||
			idsByKind[row.kind].has(id)
		) {
			throw failure(
				`mailbox dump contains an invalid or duplicate ${row.kind} id`,
			)
		}
		idsByKind[row.kind].add(id)
		switch (row.kind) {
			case 'thread':
				threads.push(row.row)
				break
			case 'message':
				messages.push(row.row)
				break
			case 'attachment':
				attachments.push(row.row)
				break
			case 'delivery_event':
				deliveryEvents.push(row.row)
				break
			default: {
				const exhaustive: never = row
				throw failure(`unhandled mailbox dump row: ${String(exhaustive)}`)
			}
		}
	}

	const threadIds = new Set(threads.map((thread) => thread.id))
	const messageIds = new Set(messages.map((message) => message.id))
	for (const message of messages) {
		if (message.threadId !== null && !threadIds.has(message.threadId)) {
			throw failure(`mailbox message ${message.id} references a missing thread`)
		}
	}
	const attachmentsByMessage = new Map<string, Array<MailboxAttachmentRecord>>()
	for (const attachment of attachments) {
		if (!messageIds.has(attachment.messageId)) {
			throw failure(
				`mailbox attachment ${attachment.id} references a missing message`,
			)
		}
		const grouped = attachmentsByMessage.get(attachment.messageId) ?? []
		grouped.push(attachment)
		attachmentsByMessage.set(attachment.messageId, grouped)
	}
	for (const event of deliveryEvents) {
		if (event.messageId !== null && !messageIds.has(event.messageId)) {
			throw failure(
				`mailbox delivery event ${event.id} references a missing message`,
			)
		}
	}
	return {
		threads,
		messages,
		attachmentsByMessage,
		deliveryEvents,
		counts: {
			threads: threads.length,
			messages: messages.length,
			attachments: attachments.length,
			deliveryEvents: deliveryEvents.length,
		},
	}
}

async function loadVerifiedMailboxDump(
	s3: DrBackupS3Client,
	day: string,
	entry: OwnerIndexEntry,
): Promise<ParsedMailboxDump> {
	const key = sealedDumpKey(day, entry.objectKey)
	const bytes = await getRequiredBytes(s3, key, 'sealed mailbox dump')
	await verifyFileBytes(
		bytes,
		entry,
		`sealed mailbox dump for ${entry.ownerId}`,
	)
	return parseMailboxDump(
		decodeUtf8(bytes, `sealed mailbox dump for ${entry.ownerId}`),
		entry.entryCount,
	)
}

function parseOwnerSelection(value: unknown): MailboxImportOwnerSelection {
	if (value === 'all-from-index') return value
	if (!Array.isArray(value) || value.length === 0) {
		throw failure('owners must be a non-empty array or "all-from-index"')
	}
	const owners = value.map((owner, index) =>
		requireExactNonEmptyString(owner, `owners[${index}]`),
	)
	if (new Set(owners).size !== owners.length) {
		throw failure('owners must not contain duplicates')
	}
	return owners
}

function selectOwners(
	index: MailboxIndex,
	selection: MailboxImportOwnerSelection,
): Array<OwnerIndexEntry> {
	if (selection === 'all-from-index') return index.entries
	const byOwner = new Map(index.entries.map((entry) => [entry.ownerId, entry]))
	return selection.map((ownerId) => {
		const entry = byOwner.get(ownerId)
		if (!entry) {
			throw failure(
				`requested owner ${ownerId} is absent from the mailbox index`,
			)
		}
		return entry
	})
}

function targetOwnerId(
	sourceOwnerId: string,
	day: string,
	drill: boolean,
): string {
	return drill
		? `${mailboxImportDrillOwnerPrefix}${day}:${encodeURIComponent(sourceOwnerId)}`
		: sourceOwnerId
}

function mailboxThreadInput(thread: MailboxThreadRecord): MailboxThreadInput {
	return {
		...thread,
		subjectNormalized: thread.subjectNormalized ?? '',
	}
}

function mailboxMessageInput(
	message: MailboxMessageRecord,
	drillTarget: string | null,
): MailboxMessageInput {
	return {
		...message,
		fromAddress: message.fromAddress ?? '',
		subject: message.subject ?? '',
		headers: message.headers ?? {},
		rawSize: message.rawSize ?? 0,
		rawMimeKey:
			drillTarget !== null && message.rawMimeKey !== null
				? emailRawMimeKey(drillTarget, message.id)
				: message.rawMimeKey,
	}
}

function mailboxAttachmentInput(
	attachment: MailboxAttachmentRecord,
	drillTarget: string | null,
): MailboxAttachmentInput {
	return {
		...attachment,
		contentType: attachment.contentType ?? 'application/octet-stream',
		storageKey:
			drillTarget !== null && attachment.storageKind === 'external'
				? emailAttachmentBlobKey(
						drillTarget,
						attachment.messageId,
						attachment.id,
					)
				: attachment.storageKey,
	}
}

function mailboxDeliveryEventInput(
	event: MailboxDeliveryEventRecord,
): MailboxDeliveryEventInput {
	return {
		...event,
		provider: event.provider ?? 'kody',
	}
}

function mailboxCountsEqual(
	left: MailboxCountResult,
	right: MailboxCountResult,
): boolean {
	return (
		left.threads === right.threads &&
		left.messages === right.messages &&
		left.attachments === right.attachments &&
		left.deliveryEvents === right.deliveryEvents
	)
}

function encodeCursor(cursor: MailboxImportCursor): string {
	return btoa(JSON.stringify(cursor))
}

function decodeCursor(
	raw: string | undefined,
	day: string,
	requestFingerprint: string,
): MailboxImportCursor {
	if (!raw) {
		return {
			version: mailboxImportCursorVersion,
			day,
			requestFingerprint,
			ownerIndex: 0,
			phase: 'prepare',
			rowIndex: 0,
			ownersPassed: 0,
			ownersMismatched: 0,
			ownersReplaced: 0,
		}
	}
	try {
		const value = JSON.parse(atob(raw)) as unknown
		if (
			!isRecord(value) ||
			value.version !== mailboxImportCursorVersion ||
			value.day !== day ||
			value.requestFingerprint !== requestFingerprint ||
			(value.phase !== 'prepare' &&
				value.phase !== 'threads' &&
				value.phase !== 'messages' &&
				value.phase !== 'delivery-events' &&
				value.phase !== 'verify' &&
				value.phase !== 'done')
		) {
			throw new Error('cursor does not match this import request')
		}
		return {
			version: mailboxImportCursorVersion,
			day,
			requestFingerprint,
			ownerIndex: requireNonNegativeInteger(value.ownerIndex, 'ownerIndex'),
			phase: value.phase,
			rowIndex: requireNonNegativeInteger(value.rowIndex, 'rowIndex'),
			ownersPassed: requireNonNegativeInteger(
				value.ownersPassed,
				'ownersPassed',
			),
			ownersMismatched: requireNonNegativeInteger(
				value.ownersMismatched,
				'ownersMismatched',
			),
			ownersReplaced: requireNonNegativeInteger(
				value.ownersReplaced,
				'ownersReplaced',
			),
		}
	} catch (error) {
		if (error instanceof MaintenanceFailureError) throw error
		throw failure(`Invalid mailbox import cursor: ${getErrorMessage(error)}`)
	}
}

async function requestFingerprint(input: {
	day: string
	owners: MailboxImportOwnerSelection
	conflictPolicy: MailboxImportConflictPolicy
	replaceConfirmation: string | null
	drill: boolean
}): Promise<string> {
	return await sha256Hex(JSON.stringify(input))
}

function progressFor(
	cursor: MailboxImportCursor,
	totalOwners: number,
	rowsProcessed: number,
): MailboxImportTickResult['progress'] {
	return {
		day: cursor.day,
		phase: cursor.phase,
		ownerIndex: cursor.ownerIndex,
		totalOwners,
		ownersPassed: cursor.ownersPassed,
		ownersMismatched: cursor.ownersMismatched,
		ownersReplaced: cursor.ownersReplaced,
		rowsProcessed,
	}
}

export async function runMailboxImportTick(input: {
	env: Env
	day: string
	owners: MailboxImportOwnerSelection
	conflictPolicy?: MailboxImportConflictPolicy
	replaceConfirmation?: string
	drill?: boolean
	cursor?: string
	timeBudgetMs?: number
	s3?: DrBackupS3Client
}): Promise<MailboxImportTickResult> {
	assertBackupDay(input.day)
	const conflictPolicy = input.conflictPolicy ?? 'refuse'
	if (conflictPolicy !== 'refuse' && conflictPolicy !== 'replace') {
		throw failure('conflictPolicy must be "refuse" or "replace"')
	}
	const replaceConfirmation = input.replaceConfirmation ?? null
	if (
		conflictPolicy === 'replace' &&
		replaceConfirmation !== mailboxImportReplaceConfirmation
	) {
		throw failure(
			`replace requires replaceConfirmation: "${mailboxImportReplaceConfirmation}"`,
		)
	}
	if (conflictPolicy === 'refuse' && replaceConfirmation !== null) {
		throw failure(
			'replaceConfirmation is only valid with conflictPolicy "replace"',
		)
	}
	const drill = input.drill ?? false
	const fingerprint = await requestFingerprint({
		day: input.day,
		owners: input.owners,
		conflictPolicy,
		replaceConfirmation,
		drill,
	})
	const cursor = decodeCursor(input.cursor, input.day, fingerprint)
	const config = readDrBackupS3Config(input.env)
	if (!input.s3 && !config) {
		throw failure('DR backup credentials are not configured')
	}
	const s3 = input.s3 ?? createDrBackupS3Client(config!)
	const index = await loadVerifiedMailboxIndex({
		s3,
		env: input.env,
		day: input.day,
	})
	const owners = selectOwners(index, input.owners)
	if (cursor.ownerIndex > owners.length) {
		throw failure('mailbox import cursor ownerIndex exceeds selected owners')
	}
	if (cursor.phase === 'done' && cursor.ownerIndex !== owners.length) {
		throw failure('mailbox import cursor reached done before all owners')
	}

	const startedAtMs = Date.now()
	const timeBudgetMs = input.timeBudgetMs ?? mailboxImportRunTimeBudgetMs
	const ownerResults: Array<MailboxImportOwnerResult> = []
	const warnings: Array<string> = []
	let rowsProcessed = 0
	const budgetExhausted = () => Date.now() - startedAtMs >= timeBudgetMs

	while (cursor.ownerIndex < owners.length && cursor.phase !== 'done') {
		const owner = owners[cursor.ownerIndex]!
		const dump = await loadVerifiedMailboxDump(s3, input.day, owner)
		const target = targetOwnerId(owner.ownerId, input.day, drill)
		const mailbox = mailboxRpc({ env: input.env, userId: target })

		if (cursor.phase === 'prepare') {
			const current = await mailbox.countMailbox()
			const nonEmpty = Object.values(current).some((count) => count > 0)
			if (nonEmpty && conflictPolicy === 'refuse') {
				throw failure(
					`target Mailbox for ${target} is non-empty; refusing import`,
					progressFor(cursor, owners.length, rowsProcessed),
				)
			}
			if (nonEmpty) {
				await mailbox.purge({ ownerId: target })
				cursor.ownersReplaced += 1
			}
			cursor.phase = 'threads'
			cursor.rowIndex = 0
		}

		while (
			cursor.phase === 'threads' &&
			cursor.rowIndex < dump.threads.length
		) {
			if (budgetExhausted()) break
			await mailbox.upsertMessageGraph({
				ownerId: target,
				thread: mailboxThreadInput(dump.threads[cursor.rowIndex]!),
				message: null,
			})
			cursor.rowIndex += 1
			rowsProcessed += 1
		}
		if (cursor.phase === 'threads' && cursor.rowIndex >= dump.threads.length) {
			cursor.phase = 'messages'
			cursor.rowIndex = 0
		}

		while (
			cursor.phase === 'messages' &&
			cursor.rowIndex < dump.messages.length
		) {
			if (budgetExhausted()) break
			const sourceMessage = dump.messages[cursor.rowIndex]!
			const sourceAttachments =
				dump.attachmentsByMessage.get(sourceMessage.id) ?? []
			const drillTarget = drill ? target : null
			const message = mailboxMessageInput(sourceMessage, drillTarget)
			const attachments = sourceAttachments.map((attachment) =>
				mailboxAttachmentInput(attachment, drillTarget),
			)
			await mailbox.upsertMessageGraph({
				ownerId: target,
				message,
				attachments,
			})
			cursor.rowIndex += 1
			rowsProcessed += 1 + attachments.length
		}
		if (
			cursor.phase === 'messages' &&
			cursor.rowIndex >= dump.messages.length
		) {
			cursor.phase = 'delivery-events'
			cursor.rowIndex = 0
		}

		while (
			cursor.phase === 'delivery-events' &&
			cursor.rowIndex < dump.deliveryEvents.length
		) {
			if (budgetExhausted()) break
			const events = dump.deliveryEvents
				.slice(
					cursor.rowIndex,
					cursor.rowIndex + mailboxUpsertDeliveryEventsMax,
				)
				.map(mailboxDeliveryEventInput)
			await mailbox.upsertDeliveryEvents({
				ownerId: target,
				events,
				restore: true,
			})
			cursor.rowIndex += events.length
			rowsProcessed += events.length
		}
		if (
			cursor.phase === 'delivery-events' &&
			cursor.rowIndex >= dump.deliveryEvents.length
		) {
			cursor.phase = 'verify'
			cursor.rowIndex = 0
		}

		if (cursor.phase === 'verify' && !budgetExhausted()) {
			const actual = await mailbox.countMailbox()
			const matches = mailboxCountsEqual(actual, dump.counts)
			ownerResults.push({
				sourceOwnerId: owner.ownerId,
				targetOwnerId: target,
				expected: dump.counts,
				actual,
				matches,
				drill,
			})
			if (matches) {
				cursor.ownersPassed += 1
			} else {
				cursor.ownersMismatched += 1
				warnings.push(`Mailbox count mismatch for ${owner.ownerId}`)
			}
			cursor.ownerIndex += 1
			cursor.phase = cursor.ownerIndex >= owners.length ? 'done' : 'prepare'
			cursor.rowIndex = 0
		}

		if (budgetExhausted()) break
	}

	if (owners.length === 0) cursor.phase = 'done'
	const done = cursor.phase === 'done'
	return {
		done,
		verified: done && cursor.ownersMismatched === 0,
		...(done ? {} : { nextCursor: encodeCursor(cursor) }),
		progress: progressFor(cursor, owners.length, rowsProcessed),
		ownerResults,
		warnings,
	}
}

function assertExactRequestKeys(body: Record<string, unknown>) {
	const allowed = new Set([
		'conflictPolicy',
		'cursor',
		'day',
		'drill',
		'owners',
		'replaceConfirmation',
	])
	for (const key of Object.keys(body)) {
		if (!allowed.has(key)) throw failure(`unknown request field: ${key}`)
	}
}

export async function handleMailboxImportRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return await handleSecretMaintenanceRequest({
		request,
		secret: env.DR_RESTORE_SECRET,
		notConfiguredMessage: 'Mailbox import is not configured',
		run: async () => {
			let body: Record<string, unknown>
			try {
				const value = (await request.json()) as unknown
				if (!isRecord(value)) throw new Error('body is not an object')
				body = value
			} catch {
				throw failure('Request body must be a JSON object')
			}
			assertExactRequestKeys(body)
			const day = requireExactNonEmptyString(body['day'], 'day')
			const owners = parseOwnerSelection(body['owners'])
			const conflictPolicy =
				body['conflictPolicy'] === undefined
					? undefined
					: body['conflictPolicy']
			if (
				conflictPolicy !== undefined &&
				conflictPolicy !== 'refuse' &&
				conflictPolicy !== 'replace'
			) {
				throw failure('conflictPolicy must be "refuse" or "replace"')
			}
			if (body['drill'] !== undefined && typeof body['drill'] !== 'boolean') {
				throw failure('drill must be a boolean')
			}
			if (
				body['replaceConfirmation'] !== undefined &&
				typeof body['replaceConfirmation'] !== 'string'
			) {
				throw failure('replaceConfirmation must be a string')
			}
			if (body['cursor'] !== undefined && typeof body['cursor'] !== 'string') {
				throw failure('cursor must be a string')
			}
			return await runMailboxImportTick({
				env,
				day,
				owners,
				conflictPolicy,
				replaceConfirmation: body['replaceConfirmation'] as string | undefined,
				drill: body['drill'] as boolean | undefined,
				cursor: body['cursor'] as string | undefined,
			})
		},
	})
}
