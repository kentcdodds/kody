import PostalMime from 'postal-mime'
import { emailRawMimeKey } from './blob-keys.ts'
import {
	createUserInboundDeliveryAuthority,
	type UserInboundDeliveryAuthorityEnv,
} from './inbound-delivery-authority.ts'
import {
	InboundDeliveryLeaseLostError,
	parseStrictInboundDeliveryDetailJson,
} from './inbound-delivery.ts'
import {
	mailboxInboundDedupePointerId,
	mailboxInboundProvider,
	mailboxStaleInboundDeliveryAgeMs,
} from './mailbox-inbound-ledger.ts'
import {
	insertEmailAttachments,
	getEmailMessageById,
	listEmailAttachmentsForMessage,
} from './repo.ts'

const staleBatchSize = 20

function parsedAttachmentSize(
	content: string | ArrayBuffer | Uint8Array<ArrayBufferLike>,
) {
	return typeof content === 'string'
		? new TextEncoder().encode(content).byteLength
		: content.byteLength
}

async function bootstrapPreDeployDueRows(input: {
	env: UserInboundDeliveryAuthorityEnv
	userId: string
	now: Date
}) {
	const rows = await input.env.APP_DB.prepare(
		`SELECT id
		FROM email_delivery_events
		WHERE user_id = ?
			AND provider = 'cloudflare-email-routing'
			AND event_type = 'receive_started'
			AND created_at < ?
		ORDER BY created_at ASC, id ASC
		LIMIT ?`,
	)
		.bind(
			input.userId,
			new Date(input.now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
			staleBatchSize,
		)
		.all<{ id: string }>()
	const authority = createUserInboundDeliveryAuthority(input)
	for (const row of rows.results ?? []) {
		await authority.get(row.id).catch((error: unknown) => {
			console.warn(
				'inbound-email-stale-bootstrap-failed',
				input.userId,
				row.id,
				error,
			)
		})
	}
}

async function recoverCommittedDelivery(input: {
	env: UserInboundDeliveryAuthorityEnv & { EMAIL_BLOBS: R2Bucket }
	userId: string
	deliveryId: string
	now: Date
}) {
	const authority = createUserInboundDeliveryAuthority(input)
	const delivery = await authority.get(input.deliveryId)
	if (!delivery) return false
	const message = await getEmailMessageById({
		db: input.env.APP_DB,
		userId: input.userId,
		messageId: delivery.messageId,
	})
	if (!message?.rawMimeKey) return false
	if (
		message.rawMimeKey !== emailRawMimeKey(input.userId, delivery.messageId)
	) {
		throw new Error(
			'Inbound message raw MIME key is outside its user namespace.',
		)
	}
	const object = await input.env.EMAIL_BLOBS.get(message.rawMimeKey)
	if (!object) return false
	const parsed = await PostalMime.parse(await object.text(), {
		attachmentEncoding: 'arraybuffer',
	})
	const claim = await authority.claimStorage(
		delivery,
		parsed.attachments.length,
		delivery.usageStartedAt,
		input.now,
	)
	if (!claim.claimed) return claim.delivery?.state === 'received'
	const storageLease = claim.delivery.storageLease
	if (!storageLease) {
		throw new InboundDeliveryLeaseLostError(
			'Recovered inbound delivery has no storage lease.',
		)
	}
	try {
		await insertEmailAttachments({
			db: input.env.APP_DB,
			messageId: message.id,
			ignoreConflicts: true,
			inboundDeliveryFence: {
				deliveryId: claim.delivery.deliveryId,
				userId: input.userId,
				storageLease,
			},
			attachments: parsed.attachments.map((attachment, index) => ({
				id: `${message.id}:attachment:${index}`,
				filename: attachment.filename,
				contentType: attachment.mimeType,
				contentId: attachment.contentId ?? null,
				disposition: attachment.disposition,
				size: parsedAttachmentSize(attachment.content),
				storageKind: 'raw-mime',
				storageKey: null,
			})),
		})
		const attachments = await listEmailAttachmentsForMessage({
			db: input.env.APP_DB,
			messageId: message.id,
		})
		if (attachments.length !== parsed.attachments.length) {
			throw new InboundDeliveryLeaseLostError(
				'Inbound attachment recovery did not commit every attachment.',
			)
		}
		await authority.receive({
			delivery: claim.delivery,
			usageDurationMs: claim.delivery.usageStartedAt
				? input.now.getTime() - Date.parse(claim.delivery.usageStartedAt)
				: 0,
			usageMonth: (message.receivedAt ?? message.createdAt).slice(0, 7),
			usageBytes: message.rawSize ?? 0,
			now: input.now,
		})
		return true
	} catch (error) {
		await authority
			.releaseStorage(claim.delivery, input.now)
			.catch(() => undefined)
		throw error
	}
}

export async function reconcileUserStaleInboundDeliveries(input: {
	env: UserInboundDeliveryAuthorityEnv & { EMAIL_BLOBS: R2Bucket }
	userId: string
	now?: Date
	deadlineMs?: number
}) {
	const now = input.now ?? new Date()
	await bootstrapPreDeployDueRows({
		env: input.env,
		userId: input.userId,
		now,
	})
	const authority = createUserInboundDeliveryAuthority(input)
	const due = await authority.listDueStale(now, staleBatchSize)
	const staleBefore = new Date(now.getTime() - mailboxStaleInboundDeliveryAgeMs)
	let recovered = 0
	let cleaned = 0
	let budgetExhausted = false
	for (const snapshot of due.deliveries) {
		if (input.deadlineMs != null && Date.now() >= input.deadlineMs) {
			budgetExhausted = true
			break
		}
		const message = await getEmailMessageById({
			db: input.env.APP_DB,
			userId: input.userId,
			messageId: snapshot.messageId,
		})
		if (message) {
			try {
				if (
					await recoverCommittedDelivery({
						env: input.env,
						userId: input.userId,
						deliveryId: snapshot.deliveryId,
						now,
					})
				) {
					recovered += 1
				} else {
					await authority.deferReconciliation(snapshot.deliveryId, now)
				}
			} catch (error) {
				console.warn(
					'inbound-email-partial-delivery-recovery-failed',
					snapshot.deliveryId,
					error,
				)
				await authority
					.deferReconciliation(snapshot.deliveryId, now)
					.catch(() => undefined)
			}
			continue
		}

		const claim = await authority.claimCleanup({
			deliveryId: snapshot.deliveryId,
			expectedState: snapshot.state,
			expectedUpdatedAt: snapshot.updatedAt,
			staleBefore,
			now,
		})
		if (claim.status !== 'claimed') continue
		const racedMessage = await getEmailMessageById({
			db: input.env.APP_DB,
			userId: input.userId,
			messageId: snapshot.messageId,
		})
		if (racedMessage) {
			await authority.releaseCleanup(
				snapshot.deliveryId,
				claim.delivery.cleanupLease!,
				now,
			)
			continue
		}
		let outcome: 'deleted' | 'delete-failed' = 'deleted'
		try {
			await input.env.EMAIL_BLOBS.delete(snapshot.rawMimeKey)
		} catch (error) {
			outcome = 'delete-failed'
			console.warn(
				'inbound-email-orphan-blob-delete-failed',
				snapshot.rawMimeKey,
				error,
			)
		}
		const finalized = await authority.markOrphanCleaned({
			deliveryId: snapshot.deliveryId,
			cleanupLease: claim.delivery.cleanupLease!,
			outcome,
			now,
		})
		if (finalized.status === 'orphan-cleaned') {
			if (outcome === 'deleted') cleaned += 1
		}
	}
	return {
		recovered,
		cleaned,
		...(budgetExhausted ? { budgetExhausted: true as const } : {}),
	}
}

export async function pruneUserExpiredInboundDedupePointers(input: {
	env: UserInboundDeliveryAuthorityEnv
	userId: string
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const authority = createUserInboundDeliveryAuthority(input)
	const bridgeRows = await input.env.APP_DB.prepare(
		`SELECT id, detail_json
		FROM email_delivery_events
		WHERE user_id = ?
			AND provider = ?
			AND COALESCE(
				dedupe_expires_at,
				json_extract(detail_json, '$.dedupeExpiresAt')
			) <= ?
		ORDER BY created_at ASC, id ASC
		LIMIT ?`,
	)
		.bind(
			input.userId,
			'cloudflare-email-routing-dedupe',
			now.toISOString(),
			input.limit ?? 20,
		)
		.all<{ id: string; detail_json: string | null }>()
	for (const row of bridgeRows.results ?? []) {
		const delivery = parseStrictInboundDeliveryDetailJson(row.detail_json)
		if (
			!delivery ||
			delivery.userId !== input.userId ||
			delivery.provider !== mailboxInboundProvider ||
			delivery.state !== 'pending' ||
			row.id !== mailboxInboundDedupePointerId(delivery.fingerprint)
		) {
			console.warn(
				'inbound-email-dedupe-bridge-row-invalid',
				input.userId,
				row.id,
			)
			continue
		}
		await authority.claimWindow(delivery, now).catch((error: unknown) => {
			console.warn(
				'inbound-email-dedupe-bridge-failed',
				input.userId,
				row.id,
				error,
			)
		})
	}
	return await authority.pruneExpiredDedupe(now, input.limit)
}
