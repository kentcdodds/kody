import { getAppBaseUrl } from '#app/app-base-url.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { listEmailAttachmentsForMessage } from './repo.ts'
import { type EmailAttachmentRecord, type EmailMessageRecord } from './types.ts'

const inboundEmailReceiptTopic = 'email.message.received'

type EmailReceiptSubscriptionEnvelope = {
	event: typeof inboundEmailReceiptTopic
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
	message: EmailMessageRecord
	attachments: Array<EmailAttachmentRecord>
}) {
	return {
		event: inboundEmailReceiptTopic,
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
}) {
	return `email:${input.messageId}:${input.packageId}:${inboundEmailReceiptTopic}`
}

async function loadMatchingEmailSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
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
					(candidate) => candidate.topic === inboundEmailReceiptTopic,
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
		requestUrl: 'https://kody.invalid',
	})
	const attachments = await listEmailAttachmentsForMessage({
		db: input.env.APP_DB,
		messageId: input.message.id,
	})
	const subscriptions = await loadMatchingEmailSubscriptions({
		env: input.env,
		baseUrl,
		userId: input.userId,
	})
	const eventPayload = buildEmailEventPayload({
		message: input.message,
		attachments,
	})
	return await Promise.all(
		subscriptions.map(async ({ savedPackage }) =>
			await invokePackageSubscription({
				env: input.env as Env,
				baseUrl,
				savedPackage,
				topic: inboundEmailReceiptTopic,
				params: eventPayload as Record<string, unknown>,
				idempotencyKey: buildSubscriptionIdempotencyKey({
					messageId: input.message.id,
					packageId: savedPackage.id,
				}),
				source: 'email',
			}),
		),
	)
}
