import { isSystemEmailOwner } from './email-owner.ts'

export type MailboxParityEnv = {
	EMAIL_EVENTS?: AnalyticsEngineDataset
}

export type MailboxMirrorOperation =
	| 'mirror_message'
	| 'upsert_delivery_event'
	| 'touch_thread'
	| 'update_message_delivery'
	| 'set_message_classification'
	| 'delete_message_metadata'
	| 'delete_delivery_event'

export type MailboxMirrorOutcome = 'mirrored' | 'stale' | 'skipped' | 'error'

export type MailboxParityOperation =
	| 'compare_threads'
	| 'compare_messages'
	| 'compare_attachments'
	| 'compare_delivery_events'

export type MailboxParityOutcome = 'match' | 'mismatch'

export type MailboxParityEvent =
	| {
			userId: string
			category: 'mirror'
			operation: MailboxMirrorOperation
			outcome: MailboxMirrorOutcome
			timestamp?: string
	  }
	| {
			userId: string
			category: 'parity'
			operation: MailboxParityOperation
			outcome: MailboxParityOutcome
			d1Count?: number
			doCount?: number
			timestamp?: string
	  }

function resolveCountDelta(event: MailboxParityEvent): number {
	if (
		event.category === 'parity' &&
		event.d1Count !== undefined &&
		event.doCount !== undefined
	) {
		return event.d1Count - event.doCount
	}
	return 0
}

/**
 * Additive Analytics Engine schema (same EMAIL_EVENTS dataset as reporting):
 *
 * - index1: stable user id (per-user isolation)
 * - blob1: mirror or parity operation
 * - blob2: operation outcome
 * - blob3: source event timestamp (ISO 8601)
 * - double1: D1-minus-DO count delta (0 when absent or not applicable)
 * - double2: event weight (always 1)
 *
 * `system:email` is excluded — operator mail stays in D1 only.
 */
export function recordMailboxParityEvent(
	env: MailboxParityEnv,
	event: MailboxParityEvent,
): void {
	try {
		if (!env.EMAIL_EVENTS || !event.userId) return
		if (isSystemEmailOwner(event.userId)) return

		env.EMAIL_EVENTS.writeDataPoint({
			indexes: [event.userId],
			blobs: [
				event.operation,
				event.outcome,
				event.timestamp ?? new Date().toISOString(),
			],
			doubles: [resolveCountDelta(event), 1],
		})
	} catch (error) {
		console.warn('mailbox-parity-event-write-failed', error)
	}
}
