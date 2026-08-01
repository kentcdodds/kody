import {
	mirrorMailboxDeliveryEventSnapshot,
	mirrorMailboxMessageSnapshot,
	type MailboxMirrorEnv,
	type MailboxMirrorResult,
} from './mailbox-mirror.ts'
import {
	getEmailDeliveryEventMirrorProjection,
	listMailboxDeliveryEventMirrorInputsForMessage,
} from './mailbox-snapshot-repo.ts'
import { toMailboxDeliveryEventInput } from './mailbox-snapshots.ts'
import { mailboxDefaultPageSize } from './mailbox-types.ts'
import {
	getEmailMessageById,
	getEmailThreadById,
	listEmailAttachmentsForMessage,
} from './repo.ts'
import { type EmailThreadRecord } from './types.ts'

/**
 * High-level D1 → Mailbox live-mirror orchestration.
 *
 * D1 remains authoritative. These helpers load cohesive snapshots from D1 and
 * call best-effort mirror RPCs; they never throw into caller paths and do not
 * perform deletes or inbound-lifecycle special cases.
 *
 * Callers that just created a thread may pass it via `thread` to avoid a
 * round-trip; otherwise the graph helper loads it with `getEmailThreadById`.
 *
 * Graph event fan-out runs concurrently after the message RPC settles so event
 * wall time stays near one RPC timeout (not limit × timeout). Analytics Engine
 * parity writes stay under the ~250/request cap: 1 message + max events.
 */

/**
 * Max delivery events mirrored per graph call.
 * `1 + mailboxLiveMirrorMaxEvents` AE writes must stay under ~250/request.
 */
export const mailboxLiveMirrorMaxEvents = mailboxDefaultPageSize

/** AE write budget headroom check (message + event outcomes). */
export const mailboxLiveMirrorMaxAnalyticsWrites =
	1 + mailboxLiveMirrorMaxEvents

export type MailboxLiveMirrorEnv = MailboxMirrorEnv

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
 * message (+ optional caller-supplied thread, attachments) first, then all
 * delivery events concurrently (cohesive projection; `created_at` as
 * `sourceMutationAt`).
 *
 * Never throws. Returns a bounded structured summary. Queries `max+1` events
 * so truncation is explicit; mirrors at most {@link mailboxLiveMirrorMaxEvents}.
 *
 * @param sourceMutationAt - Optional caller mutation timestamp for context;
 *   D1 row timestamps remain authoritative. Delivery events always use
 *   `created_at` for immutable outbound/provider inserts.
 * @param thread - Optional thread from the caller. When omitted, loads via
 *   `getEmailThreadById` when `message.threadId` is set. Explicit `null`
 *   skips the thread snapshot.
 */
export async function mirrorMailboxMessageGraphFromD1(input: {
	env: MailboxLiveMirrorEnv
	db: D1Database
	userId: string
	messageId: string
	sourceMutationAt?: string
	thread?: EmailThreadRecord | null
}): Promise<MailboxLiveMirrorGraphSummary> {
	// Caller mutation timestamp is accepted for API symmetry with dual-write
	// sites; D1 row timestamps remain authoritative for the loaded graph.
	void input.sourceMutationAt
	try {
		const message = await getEmailMessageById({
			db: input.db,
			userId: input.userId,
			messageId: input.messageId,
		})
		if (!message) {
			return emptyGraphSummary(input.messageId, { status: 'missing' })
		}

		const attachments = await listEmailAttachmentsForMessage({
			db: input.db,
			messageId: input.messageId,
		})

		let thread = input.thread
		if (thread === undefined && message.threadId) {
			thread = await getEmailThreadById({
				db: input.db,
				userId: input.userId,
				threadId: message.threadId,
			})
		}

		// Message settles before any event RPC starts (ordering guarantee).
		const messageResult = await mirrorMailboxMessageSnapshot({
			env: input.env,
			thread,
			message,
			attachments,
		})

		const loadedEvents = await listMailboxDeliveryEventMirrorInputsForMessage({
			db: input.db,
			ownerId: input.userId,
			messageId: input.messageId,
			limit: mailboxLiveMirrorMaxEvents + 1,
		})
		const eventsTruncated = loadedEvents.length > mailboxLiveMirrorMaxEvents
		const eventInputs = eventsTruncated
			? loadedEvents.slice(0, mailboxLiveMirrorMaxEvents)
			: loadedEvents

		// Concurrent fan-out: event-phase wall time ≈ one RPC timeout, not N×.
		const events = await Promise.all(
			eventInputs.map(async (event) => ({
				eventId: event.id,
				result: await mirrorMailboxDeliveryEventSnapshot({
					env: input.env,
					ownerId: input.userId,
					event,
				}),
			})),
		)

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
