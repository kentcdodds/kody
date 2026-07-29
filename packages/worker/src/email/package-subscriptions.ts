import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import {
	dispatchAdminPackageSubscriptionEvent,
	readPreExecutionPackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type CloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { listEmailAttachmentsForMessage } from './repo.ts'
import { type EmailAttachmentRecord, type EmailMessageRecord } from './types.ts'

const inboundEmailReceiptTopic = 'email.message.received'
export const inboundEmailQuarantinedTopic = 'email.message.quarantined'
const systemInboundEmailReceiptTopic = 'email.system-message.received'
export const emailDeliveryUpdatedTopic = 'email.message.delivery.updated'

type EmailReceiptSubscriptionEnvelope = {
	event:
		| typeof inboundEmailReceiptTopic
		| typeof inboundEmailQuarantinedTopic
		| typeof systemInboundEmailReceiptTopic
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
		classification: EmailMessageRecord['classification']
		classification_reason: string | null
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
			classification: input.message.classification,
			classification_reason: input.message.classificationReason,
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
			return {
				subscriptions: [] as Array<LoadedEmailSubscription>,
				discoveryErrors: [] as Array<unknown>,
			}
		}
		throw error
	}
	const settled = await Promise.allSettled(
		savedPackages.map(async (savedPackage) => {
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
		}),
	)
	const subscriptions: Array<LoadedEmailSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn('Failed to load package manifest for email subscription', {
			sourceId: savedPackage?.sourceId,
			packageId: savedPackage?.id,
			error: result.reason,
		})
		discoveryErrors.push(result.reason)
	}
	return { subscriptions, discoveryErrors }
}

export async function dispatchInboundEmailSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	message: EmailMessageRecord
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({
		env: input.env,
	})
	const attachments = await listEmailAttachmentsForMessage({
		db: input.env.APP_DB,
		messageId: input.message.id,
	})
	const topic =
		input.message.classification === 'quarantined'
			? inboundEmailQuarantinedTopic
			: inboundEmailReceiptTopic
	const { subscriptions, discoveryErrors } =
		await loadMatchingEmailSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
			topic,
		})
	const eventPayload = buildEmailEventPayload({
		event: topic,
		message: input.message,
		attachments,
	})
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic,
						params: eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							messageId: input.message.id,
							packageId: savedPackage.id,
							topic,
						}),
						source: 'email',
						waitUntil: input.waitUntil,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)
	const invocationError = settled.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	)
	if (discoveryErrors.length > 0 || invocationError) {
		throw new Error(
			'Inbound email package subscription dispatch was incomplete.',
			{
				cause: discoveryErrors[0] ?? invocationError?.reason,
			},
		)
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

export async function dispatchEmailDeliverySubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	message: EmailMessageRecord
	providerEvent: CloudflareEmailDeliveryEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingEmailSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.message.userId,
			topic: emailDeliveryUpdatedTopic,
		})
	const payload = {
		event: emailDeliveryUpdatedTopic,
		message: {
			id: input.message.id,
			inbox_id: input.message.inboxId,
			thread_id: input.message.threadId,
			from_address: input.message.fromAddress,
			to_addresses: stringArray(input.message.toAddresses),
			subject: input.message.subject,
			processing_status: input.message.processingStatus,
			provider_message_id: input.message.providerMessageId,
			delivery_status: input.message.deliveryStatus,
			delivery_status_at: input.message.deliveryStatusAt,
			sent_at: input.message.sentAt,
			created_at: input.message.createdAt,
		},
		delivery: {
			event_id: input.providerEvent.payload.eventId,
			status: input.providerEvent.payload.delivery.status,
			terminal: input.providerEvent.payload.terminal,
			sender: input.providerEvent.payload.sender,
			recipient: input.providerEvent.payload.recipient,
			delivery: input.providerEvent.payload.delivery,
			bounce: input.providerEvent.payload.bounce ?? null,
			failure: input.providerEvent.payload.failure ?? null,
			rejection: input.providerEvent.payload.rejection ?? null,
			complaint: input.providerEvent.payload.complaint ?? null,
			occurred_at: input.providerEvent.metadata.eventTimestamp,
		},
	}
	const results = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.all(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: emailDeliveryUpdatedTopic,
						params: payload,
						idempotencyKey: `email-delivery:${input.providerEvent.payload.eventId}:${savedPackage.id}`,
						source: 'email',
						waitUntil: input.waitUntil,
					})
					return {
						response,
						retryableCode:
							readPreExecutionPackageInvocationInfrastructureCode(response),
					}
				}),
			),
	)
	const retryableResult = results.find((result) => result.retryableCode)
	if (discoveryErrors.length > 0 || retryableResult) {
		throw new Error('Email delivery subscription dispatch was incomplete.', {
			cause:
				discoveryErrors[0] ??
				new Error(
					`Retryable package invocation infrastructure response: ${retryableResult?.retryableCode}.`,
				),
		})
	}
	return results.map((result) => result.response)
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
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({
		env: input.env,
	})
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: systemInboundEmailReceiptTopic,
		async getParams() {
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
			return eventPayload as Record<string, unknown>
		},
		source: 'email',
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
		retryOnlyPreExecutionInfrastructureFailures: true,
		buildIdempotencyKey: (savedPackage) =>
			buildSubscriptionIdempotencyKey({
				messageId: input.message.id,
				packageId: savedPackage.id,
				topic: systemInboundEmailReceiptTopic,
			}),
		waitUntil: input.waitUntil,
	})
}
