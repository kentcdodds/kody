import { getAppBaseUrl } from '#app/app-base-url.ts'
import { listAdminAccountRows } from '#app/permissions-db.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { listEmailAttachmentsForMessage } from './repo.ts'
import { type EmailAttachmentRecord, type EmailMessageRecord } from './types.ts'

const inboundEmailReceiptTopic = 'email.message.received'
const systemInboundEmailReceiptTopic = 'email.system-message.received'

type EmailReceiptSubscriptionEnvelope = {
	event: typeof inboundEmailReceiptTopic | typeof systemInboundEmailReceiptTopic
	message: {
		id: string
		inbox_id: string | null
		from_address: string | null
		envelope_from: string | null
		to_addresses: Array<string>
		cc_addresses: Array<string>
		reply_to_addresses: Array<string>
		subject: string | null
		message_id_header: string | null
		in_reply_to_header: string | null
		references: Array<string>
		processing_status: EmailMessageRecord['processingStatus']
		received_at: string | null
		created_at: string
	}
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		storage_key: string | null
		created_at: string
	}>
}

type SystemEmailReceiptSubscriptionEnvelope =
	EmailReceiptSubscriptionEnvelope & {
		event: typeof systemInboundEmailReceiptTopic
		/** Admin-interface link for the stored system message. */
		admin_url: string
	}

type LoadedEmailSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

function stringArray(values: ReadonlyArray<unknown>) {
	return values.filter((value): value is string => typeof value === 'string')
}

function toRuntimeAttachmentMetadata(attachment: EmailAttachmentRecord) {
	return {
		id: attachment.id,
		filename: attachment.filename,
		content_type: attachment.contentType,
		content_id: attachment.contentId,
		disposition: attachment.disposition,
		size: attachment.size,
		storage_kind: attachment.storageKind,
		storage_key: attachment.storageKey,
		created_at: attachment.createdAt,
	}
}

function buildEmailEventPayload(input: {
	event: EmailReceiptSubscriptionEnvelope['event']
	message: EmailMessageRecord
	attachments: Array<EmailAttachmentRecord>
}) {
	return {
		event: input.event,
		message: {
			id: input.message.id,
			inbox_id: input.message.inboxId,
			from_address: input.message.fromAddress,
			envelope_from: input.message.envelopeFrom,
			to_addresses: stringArray(input.message.toAddresses),
			cc_addresses: stringArray(input.message.ccAddresses),
			reply_to_addresses: stringArray(input.message.replyToAddresses),
			subject: input.message.subject,
			message_id_header: input.message.messageIdHeader,
			in_reply_to_header: input.message.inReplyToHeader,
			references: stringArray(input.message.references),
			processing_status: input.message.processingStatus,
			received_at: input.message.receivedAt,
			created_at: input.message.createdAt,
		},
		attachments: input.attachments.map(toRuntimeAttachmentMetadata),
	} satisfies EmailReceiptSubscriptionEnvelope
}

function buildSubscriptionIdempotencyKey(input: {
	messageId: string
	packageId: string
	topic: string
}) {
	return `email:${input.messageId}:${input.packageId}:${input.topic}`
}

async function loadMatchingEmailSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: string
}) {
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes('no such table: saved_packages')
		) {
			return []
		}
		throw error
	}
	const settled = await Promise.all(
		savedPackages.map(async (savedPackage) => {
			try {
				const loaded = await loadPackageManifestBySourceId({
					env: input.env as Env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: savedPackage.sourceId,
				})
				const subscription = listPackageSubscriptions(loaded.manifest).find(
					(candidate) => candidate.topic === input.topic,
				)
				if (!subscription) return null
				return { savedPackage, subscription } satisfies LoadedEmailSubscription
			} catch (error) {
				console.warn('Failed to load package manifest for email subscription', {
					sourceId: savedPackage.sourceId,
					packageId: savedPackage.id,
					error,
				})
				return null
			}
		}),
	)
	return settled.filter(
		(entry): entry is LoadedEmailSubscription => entry !== null,
	)
}

export async function dispatchInboundEmailSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	message: EmailMessageRecord
}) {
	const baseUrl = getAppBaseUrl({
		env: input.env,
	})
	const attachments = await listEmailAttachmentsForMessage({
		db: input.env.APP_DB,
		messageId: input.message.id,
	})
	const subscriptions = await loadMatchingEmailSubscriptions({
		env: input.env,
		baseUrl,
		userId: input.userId,
		topic: inboundEmailReceiptTopic,
	})
	const eventPayload = buildEmailEventPayload({
		event: inboundEmailReceiptTopic,
		message: input.message,
		attachments,
	})
	return await Promise.all(
		subscriptions.map(
			async ({ savedPackage }) =>
				await invokePackageSubscription({
					env: input.env as Env,
					baseUrl,
					savedPackage,
					topic: inboundEmailReceiptTopic,
					params: eventPayload as Record<string, unknown>,
					idempotencyKey: buildSubscriptionIdempotencyKey({
						messageId: input.message.id,
						packageId: savedPackage.id,
						topic: inboundEmailReceiptTopic,
					}),
					source: 'email',
				}),
		),
	)
}

async function listAdminStableUserIds(db: D1Database) {
	const rows = await listAdminAccountRows(db)
	// One unresolvable admin row (for example corrupt account data) must not
	// block dispatch to the remaining admins.
	const settled = await Promise.allSettled(
		rows.map(async (row) => await resolveUserStableId(row)),
	)
	const stableIds = new Set<string>()
	for (const result of settled) {
		if (result.status === 'fulfilled' && result.value) {
			stableIds.add(result.value)
			continue
		}
		if (result.status === 'rejected') {
			console.warn(
				'Failed to resolve admin stable user id for system email dispatch',
				result.reason,
			)
		}
	}
	return Array.from(stableIds)
}

/**
 * Fan a stored system-inbox message (`system:email` owner) out to packages
 * saved by users who hold the admin role at dispatch time. The payload is the
 * same metadata-first envelope as `email.message.received` on a dedicated
 * `email.system-message.received` topic, plus an `admin_url` link to the
 * message in the admin interface — handlers run as the admin package owner,
 * not the system owner, so they read full contents through the admin UI/API
 * rather than the user-scoped email helpers.
 */
export async function dispatchSystemInboundEmailSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	message: EmailMessageRecord
}) {
	const baseUrl = getAppBaseUrl({
		env: input.env,
	})
	const adminUserIds = await listAdminStableUserIds(input.env.APP_DB)
	if (adminUserIds.length === 0) return []
	const attachments = await listEmailAttachmentsForMessage({
		db: input.env.APP_DB,
		messageId: input.message.id,
	})
	const eventPayload = {
		...buildEmailEventPayload({
			event: systemInboundEmailReceiptTopic,
			message: input.message,
			attachments,
		}),
		event: systemInboundEmailReceiptTopic,
		admin_url: `${baseUrl}/admin/system-email?messageId=${encodeURIComponent(
			input.message.id,
		)}`,
	} satisfies SystemEmailReceiptSubscriptionEnvelope
	const subscriptionGroups = await Promise.all(
		adminUserIds.map(
			async (userId) =>
				await loadMatchingEmailSubscriptions({
					env: input.env,
					baseUrl,
					userId,
					topic: systemInboundEmailReceiptTopic,
				}),
		),
	)
	return await Promise.all(
		subscriptionGroups.flat().map(
			async ({ savedPackage }) =>
				await invokePackageSubscription({
					env: input.env as Env,
					baseUrl,
					savedPackage,
					topic: systemInboundEmailReceiptTopic,
					params: eventPayload as Record<string, unknown>,
					idempotencyKey: buildSubscriptionIdempotencyKey({
						messageId: input.message.id,
						packageId: savedPackage.id,
						topic: systemInboundEmailReceiptTopic,
					}),
					source: 'email',
				}),
		),
	)
}
