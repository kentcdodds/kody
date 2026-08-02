import {
	mirrorMailboxDeliveryEventSnapshot,
	mirrorMailboxDeliveryEventSnapshots,
	mirrorMailboxMessageSnapshot,
	type MailboxMirrorEnv,
	type MailboxMirrorResult,
} from './mailbox-mirror.ts'
import {
	getEmailDeliveryEventMirrorProjection,
	listMailboxDeliveryEventMirrorInputsForMessage,
} from './mailbox-snapshot-repo.ts'
import { toMailboxDeliveryEventInput } from './mailbox-snapshots.ts'
import { mailboxUpsertDeliveryEventsMax } from './mailbox-types.ts'
import {
	getEmailMessageById,
	getEmailThreadById,
	listEmailAttachmentsForMessage,
} from './repo.ts'
import { type EmailThreadRecord } from './types.ts'
import {
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
} from './mailbox-inbound-ledger.ts'

/**
 * High-level D1 → Mailbox live-mirror orchestration.
 *
 * D1 remains authoritative for the message graph and non-USER-inbound events.
 * These helpers load cohesive snapshots from D1 and call best-effort mirror
 * RPCs; they never throw into caller paths and do not perform deletes or
 * inbound-lifecycle special cases. USER inbound terminal work explicitly omits
 * delivery events because those snapshots flow Mailbox → D1.
 *
 * Callers that just created a thread may pass it via `thread` to avoid a
 * round-trip; otherwise the graph helper loads it with `getEmailThreadById`.
 *
 * Graph event mirroring uses one batch RPC after the message settles (not
 * Promise.all of per-event RPCs). Analytics Engine parity writes are at most
 * two per graph attempt: 1 message outcome + 1 batch outcome.
 */

/**
 * Max delivery events mirrored per graph call.
 * Matches the DO batch RPC bound ({@link mailboxUpsertDeliveryEventsMax}).
 */
export const mailboxLiveMirrorMaxEvents = mailboxUpsertDeliveryEventsMax

/** AE write budget cap: at most two writes (message + batch). */
export const mailboxLiveMirrorMaxAnalyticsWrites = 2

export type MailboxLiveMirrorEnv = MailboxMirrorEnv

function isUserInboundAuthorityProvider(provider: string | null) {
	return (
		provider === mailboxInboundProvider ||
		provider === mailboxInboundDedupeProvider
	)
}

export type MailboxLiveMirrorEventResult = {
	eventId: string
	result: MailboxMirrorResult
}

/**
 * Bounded summary for one message graph mirror attempt.
 * Always returned; never thrown.
 */
export type MailboxLiveMirrorGraphSummary = {
	messageId: string
	message: MailboxMirrorResult
	events: Array<MailboxLiveMirrorEventResult>
	/** True when D1 had more than {@link mailboxLiveMirrorMaxEvents} events. */
	eventsTruncated: boolean
}

function emptyGraphSummary(
	messageId: string,
	message: MailboxMirrorResult,
): MailboxLiveMirrorGraphSummary {
	return {
		messageId,
		message,
		events: [],
		eventsTruncated: false,
	}
}

/**
 * Load one ready delivery-event projection from D1 and mirror it.
 *
 * When `sourceMutationAt` is omitted, uses the event's `created_at` (immutable
 * outbound/provider inserts). Returns `{ status: 'missing' }` when the D1 row
 * is absent; never throws.
 */
export async function mirrorMailboxDeliveryEventFromD1(input: {
	env: MailboxLiveMirrorEnv
	db: D1Database
	userId: string
	eventId: string
	sourceMutationAt?: string
}): Promise<MailboxMirrorResult> {
	try {
		const projection = await getEmailDeliveryEventMirrorProjection({
			db: input.db,
			ownerId: input.userId,
			eventId: input.eventId,
		})
		if (!projection) return { status: 'missing' }
		if (isUserInboundAuthorityProvider(projection.provider)) {
			return { status: 'skipped', reason: 'user-inbound-authority' }
		}
		const sourceMutationAt =
			input.sourceMutationAt != null && input.sourceMutationAt.length > 0
				? input.sourceMutationAt
				: projection.createdAt
		return await mirrorMailboxDeliveryEventSnapshot({
			env: input.env,
			ownerId: input.userId,
			event: toMailboxDeliveryEventInput({
				projection,
				sourceMutationAt,
			}),
		})
	} catch (error) {
		console.warn('mailbox-live-mirror-delivery-event-failed', error)
		return { status: 'error', error }
	}
}

/**
 * Load the authoritative D1 message graph and best-effort mirror it:
 * message (+ optional caller-supplied thread, attachments) first, then a
 * bounded batch of delivery events (cohesive projection; `created_at` as
 * `sourceMutationAt`) via one RPC after the message settles.
 *
 * Never throws. Returns a bounded structured summary. Queries newest
 * `max+1` events so truncation is explicit; mirrors at most
 * {@link mailboxLiveMirrorMaxEvents} in chronological order.
 *
 * @param thread - Optional thread from the caller. When omitted, loads via
 *   `getEmailThreadById` when `message.threadId` is set. Explicit `null`
 *   skips the thread snapshot.
 */
export async function mirrorMailboxMessageGraphFromD1(input: {
	env: MailboxLiveMirrorEnv
	db: D1Database
	userId: string
	messageId: string
	thread?: EmailThreadRecord | null
	/** USER inbound terminal work keeps its DO-authoritative event untouched. */
	includeDeliveryEvents?: boolean
}): Promise<MailboxLiveMirrorGraphSummary> {
	try {
		const message = await getEmailMessageById({
			db: input.db,
			userId: input.userId,
			messageId: input.messageId,
		})
		if (!message) {
			return emptyGraphSummary(input.messageId, { status: 'missing' })
		}

		// After the owner-scoped message load, fan out attachment + optional
		// thread reads concurrently.
		const [attachments, thread] = await Promise.all([
			listEmailAttachmentsForMessage({
				db: input.db,
				messageId: input.messageId,
			}),
			input.thread !== undefined
				? Promise.resolve(input.thread)
				: message.threadId
					? getEmailThreadById({
							db: input.db,
							userId: input.userId,
							threadId: message.threadId,
						})
					: Promise.resolve(null),
		])

		// Message settles before the event-batch RPC starts (ordering guarantee).
		const messageResult = await mirrorMailboxMessageSnapshot({
			env: input.env,
			thread,
			message,
			attachments,
		})
		if (input.includeDeliveryEvents === false) {
			return emptyGraphSummary(input.messageId, messageResult)
		}

		// Newest max+1 from D1 (chrono-restored). When truncated, keep the
		// trailing newest max — drop the oldest overflow row at index 0.
		const loadedEvents = await listMailboxDeliveryEventMirrorInputsForMessage({
			db: input.db,
			ownerId: input.userId,
			messageId: input.messageId,
			limit: mailboxLiveMirrorMaxEvents + 1,
		})
		const eventsTruncated = loadedEvents.length > mailboxLiveMirrorMaxEvents
		if (eventsTruncated) {
			console.warn('mailbox-live-mirror-events-truncated', {
				userId: input.userId,
				messageId: input.messageId,
				loaded: loadedEvents.length,
				max: mailboxLiveMirrorMaxEvents,
			})
		}
		const eventInputs = (
			eventsTruncated
				? loadedEvents.slice(-mailboxLiveMirrorMaxEvents)
				: loadedEvents
		).filter((event) => !isUserInboundAuthorityProvider(event.provider))

		const events =
			eventInputs.length === 0
				? []
				: await mirrorMailboxDeliveryEventSnapshots({
						env: input.env,
						ownerId: input.userId,
						events: eventInputs,
					})

		return {
			messageId: input.messageId,
			message: messageResult,
			events,
			eventsTruncated,
		}
	} catch (error) {
		console.warn('mailbox-live-mirror-message-graph-failed', error)
		return emptyGraphSummary(input.messageId, { status: 'error', error })
	}
}
