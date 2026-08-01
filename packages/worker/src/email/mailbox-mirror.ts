import { isSystemEmailOwner } from './email-owner.ts'
import {
	mailboxNamespace,
	mailboxRpc,
	type MailboxEnv,
} from './mailbox-client.ts'
import {
	recordMailboxParityEvent,
	type MailboxMirrorOperation,
	type MailboxMirrorOutcome,
	type MailboxParityEnv,
} from './mailbox-parity-events.ts'
import {
	toMailboxAttachmentInput,
	toMailboxMessageInput,
	toMailboxThreadInput,
} from './mailbox-snapshots.ts'
import {
	type EmailAttachmentRecord,
	type EmailDeliveryStatus,
	type EmailMessageRecord,
	type EmailThreadRecord,
} from './types.ts'
import {
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxPartialMutationResult,
	type MailboxSetMessageClassificationInput,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
	type MailboxUpsertDeliveryEventsResult,
} from './mailbox-types.ts'

/**
 * Best-effort D1 → Mailbox dual-write helpers.
 *
 * Never throw into D1 authority paths: catch/log with stable tags and return
 * structured outcomes (`mirrored | stale | missing | timeout | skipped |
 * error`). `system:email` stays in D1 only.
 *
 * Every awaited DO RPC is bounded by {@link mailboxMirrorRpcTimeoutMs} unless a
 * helper accepts an explicit `timeoutMs` override (batch delivery-event mirror
 * for scheduled parity). Partial mutation `missing` stays distinct from
 * `mirrored`; delete `missing` maps to `mirrored` because desired absence is
 * achieved. Outcomes are recorded via `recordMailboxParityEvent` when a user
 * id is known.
 *
 * Delivery-event snapshots should be loaded via
 * `getMailboxDeliveryEventMirrorInput` (mailbox-snapshot-repo) so callers do
 * not supply promoted D1 columns individually.
 */

/** Bound every awaited Mailbox DO mirror RPC (~1s). */
export const mailboxMirrorRpcTimeoutMs = 1_000

export type MailboxMirrorEnv = MailboxEnv & MailboxParityEnv

export type MailboxMirrorSkipReason =
	| 'system-email'
	| 'mailbox-unconfigured'
	| 'missing-owner'

export type MailboxMirrorResult =
	| { status: 'mirrored' }
	| { status: 'stale' }
	| { status: 'missing' }
	| { status: 'timeout' }
	| { status: 'skipped'; reason: MailboxMirrorSkipReason }
	| { status: 'error'; error: unknown }

export type MailboxMirrorDeliveryEventBatchItemResult = {
	eventId: string
	result: MailboxMirrorResult
}

function resolveMirrorOwner(
	ownerId: string | null | undefined,
): { ok: true; ownerId: string } | { ok: false; result: MailboxMirrorResult } {
	if (ownerId == null || ownerId.length === 0) {
		return { ok: false, result: { status: 'skipped', reason: 'missing-owner' } }
	}
	if (isSystemEmailOwner(ownerId)) {
		return {
			ok: false,
			result: { status: 'skipped', reason: 'system-email' },
		}
	}
	return { ok: true, ownerId }
}

function skipIfMailboxMissing(
	env: MailboxMirrorEnv,
): MailboxMirrorResult | null {
	if (!mailboxNamespace(env)) {
		return { status: 'skipped', reason: 'mailbox-unconfigured' }
	}
	return null
}

function mirrorOutcome(result: MailboxMirrorResult): MailboxMirrorOutcome {
	switch (result.status) {
		case 'mirrored':
		case 'stale':
		case 'missing':
		case 'timeout':
		case 'error':
			return result.status
		case 'skipped':
			return 'skipped'
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled mailbox mirror result: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

function recordMirrorOutcome(
	env: MailboxMirrorEnv,
	userId: string | null | undefined,
	operation: MailboxMirrorOperation,
	result: MailboxMirrorResult,
): void {
	if (userId == null || userId.length === 0) return
	recordMailboxParityEvent(env, {
		userId,
		category: 'mirror',
		operation,
		outcome: mirrorOutcome(result),
	})
}

/** Map touch/update/classify: accepted → mirrored; missing/stale stay distinct. */
function outcomeFromPartialMutation(
	result: MailboxPartialMutationResult,
): MailboxMirrorResult {
	switch (result.status) {
		case 'accepted':
			return { status: 'mirrored' }
		case 'missing':
			return { status: 'missing' }
		case 'stale':
			return { status: 'stale' }
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled mailbox partial mutation status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

/** Map delete RPC: deleted/missing → mirrored; stale → stale. */
function outcomeFromDeleteResult(
	result: MailboxDeleteResult,
): MailboxMirrorResult {
	switch (result.status) {
		case 'deleted':
		case 'missing':
			return { status: 'mirrored' }
		case 'stale':
			return { status: 'stale' }
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled mailbox delete status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

function outcomeFromAccepted(accepted: boolean): MailboxMirrorResult {
	return accepted ? { status: 'mirrored' } : { status: 'stale' }
}

function outcomeFromBatchAccepted(
	results: MailboxUpsertDeliveryEventsResult['results'],
): MailboxMirrorResult {
	return results.every((item) => item.accepted)
		? { status: 'mirrored' }
		: { status: 'stale' }
}

/**
 * Race a DO RPC against {@link mailboxMirrorRpcTimeoutMs}.
 * The settled wrapper ensures a late rejection cannot become unhandled.
 */
export async function awaitMailboxMirrorRpc<T>(
	rpc: Promise<T>,
	timeoutMs: number = mailboxMirrorRpcTimeoutMs,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
	const settled = rpc.then(
		(value) => ({ kind: 'fulfilled' as const, value }),
		(error: unknown) => ({ kind: 'rejected' as const, error }),
	)
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const raced = await Promise.race([
			settled,
			new Promise<{ kind: 'timeout' }>((resolve) => {
				timeoutId = setTimeout(() => {
					resolve({ kind: 'timeout' })
				}, timeoutMs)
			}),
		])
		if (raced.kind === 'timeout') {
			return { ok: false, timedOut: true }
		}
		if (raced.kind === 'rejected') {
			throw raced.error
		}
		return { ok: true, value: raced.value }
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

/**
 * Shared owner/config/timeout/telemetry pipeline for single-result mirror RPCs.
 * Thin wrappers supply only the RPC call and result mapping.
 */
async function executeMailboxMirrorRpc<T>(input: {
	tag: string
	env: MailboxMirrorEnv
	ownerId: string | null | undefined
	operation: MailboxMirrorOperation
	call: (ownerId: string) => Promise<T>
	toResult: (value: T) => MailboxMirrorResult
}): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		recordMirrorOutcome(input.env, input.ownerId, input.operation, owner.result)
		return owner.result
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		recordMirrorOutcome(
			input.env,
			owner.ownerId,
			input.operation,
			skippedMailbox,
		)
		return skippedMailbox
	}

	let result: MailboxMirrorResult
	try {
		const raced = await awaitMailboxMirrorRpc(input.call(owner.ownerId))
		result = raced.ok ? input.toResult(raced.value) : { status: 'timeout' }
	} catch (error) {
		console.warn(input.tag, error)
		result = { status: 'error', error }
	}
	recordMirrorOutcome(input.env, owner.ownerId, input.operation, result)
	return result
}

function mapUniformBatchResults(
	events: Array<{ id: string }>,
	result: MailboxMirrorResult,
): Array<MailboxMirrorDeliveryEventBatchItemResult> {
	return events.map((event) => ({ eventId: event.id, result }))
}

/** Best-effort full message (+ optional thread/attachments) snapshot mirror. */
export async function mirrorMailboxMessageSnapshot(input: {
	env: MailboxMirrorEnv
	thread?: EmailThreadRecord | null
	message: EmailMessageRecord
	attachments?: Array<EmailAttachmentRecord>
}): Promise<MailboxMirrorResult> {
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-message-failed',
		env: input.env,
		ownerId: input.message.userId,
		operation: 'mirror_message',
		call: (ownerId) =>
			mailboxRpc({ env: input.env, userId: ownerId }).mirrorMessage({
				ownerId,
				thread: input.thread ? toMailboxThreadInput(input.thread) : null,
				message: toMailboxMessageInput(input.message),
				attachments: input.attachments?.map(toMailboxAttachmentInput),
			}),
		toResult: (value) => outcomeFromAccepted(value.accepted),
	})
}

/**
 * Best-effort delivery-event snapshot mirror.
 *
 * Prefer loading `event` with `getMailboxDeliveryEventMirrorInput` so promoted
 * D1 columns and detail decoding stay cohesive. `event.updatedAt` must be the
 * canonical `sourceMutationAt` from that load (inserts: `created_at`).
 */
export async function mirrorMailboxDeliveryEventSnapshot(input: {
	env: MailboxMirrorEnv
	ownerId: string
	event: MailboxDeliveryEventInput
	latestDeliveryStatus?: {
		messageId: string
		deliveryStatus: EmailDeliveryStatus
		deliveryStatusAt: string
	} | null
}): Promise<MailboxMirrorResult> {
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-delivery-event-failed',
		env: input.env,
		ownerId: input.ownerId,
		operation: 'upsert_delivery_event',
		call: (ownerId) =>
			mailboxRpc({ env: input.env, userId: ownerId }).upsertDeliveryEvent({
				ownerId,
				event: input.event,
				latestDeliveryStatus: input.latestDeliveryStatus,
			}),
		toResult: (value) => outcomeFromAccepted(value.accepted),
	})
}

/**
 * Best-effort batch delivery-event snapshot mirror.
 *
 * One timeout (default {@link mailboxMirrorRpcTimeoutMs}) and one
 * `upsert_delivery_event_batch` telemetry outcome. Timeout/error/skip apply
 * uniformly to each per-event summary entry. Empty `events` returns `[]`
 * without RPC or telemetry.
 */
export async function mirrorMailboxDeliveryEventSnapshots(input: {
	env: MailboxMirrorEnv
	ownerId: string
	events: Array<MailboxDeliveryEventInput>
	/** Override RPC timeout; defaults to {@link mailboxMirrorRpcTimeoutMs}. */
	timeoutMs?: number
}): Promise<Array<MailboxMirrorDeliveryEventBatchItemResult>> {
	const operation = 'upsert_delivery_event_batch' as const
	if (input.events.length === 0) return []

	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		recordMirrorOutcome(input.env, input.ownerId, operation, owner.result)
		return mapUniformBatchResults(input.events, owner.result)
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		recordMirrorOutcome(input.env, owner.ownerId, operation, skippedMailbox)
		return mapUniformBatchResults(input.events, skippedMailbox)
	}

	try {
		const raced = await awaitMailboxMirrorRpc(
			mailboxRpc({
				env: input.env,
				userId: owner.ownerId,
			}).upsertDeliveryEvents({
				ownerId: owner.ownerId,
				events: input.events,
			}),
			input.timeoutMs ?? mailboxMirrorRpcTimeoutMs,
		)
		if (!raced.ok) {
			const result = { status: 'timeout' as const }
			recordMirrorOutcome(input.env, owner.ownerId, operation, result)
			return mapUniformBatchResults(input.events, result)
		}
		recordMirrorOutcome(
			input.env,
			owner.ownerId,
			operation,
			outcomeFromBatchAccepted(raced.value.results),
		)
		const byEventId = new Map(
			raced.value.results.map((item) => [item.eventId, item] as const),
		)
		return input.events.map((event) => {
			const item = byEventId.get(event.id)
			return {
				eventId: event.id,
				result: item
					? outcomeFromAccepted(item.accepted)
					: { status: 'missing' as const },
			}
		})
	} catch (error) {
		console.warn('mailbox-mirror-delivery-event-batch-failed', error)
		const result = { status: 'error' as const, error }
		recordMirrorOutcome(input.env, owner.ownerId, operation, result)
		return mapUniformBatchResults(input.events, result)
	}
}

/** Best-effort thread touch mirror. */
export async function mirrorMailboxTouchThread(
	input: MailboxTouchThreadInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const { env, ...rpcInput } = input
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-touch-thread-failed',
		env,
		ownerId: input.ownerId,
		operation: 'touch_thread',
		call: (ownerId) =>
			mailboxRpc({ env, userId: ownerId }).touchThread(rpcInput),
		toResult: outcomeFromPartialMutation,
	})
}

/** Best-effort outbound delivery/processing update mirror. */
export async function mirrorMailboxUpdateMessageDelivery(
	input: MailboxUpdateMessageDeliveryInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const { env, ...rpcInput } = input
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-update-message-delivery-failed',
		env,
		ownerId: input.ownerId,
		operation: 'update_message_delivery',
		call: (ownerId) =>
			mailboxRpc({ env, userId: ownerId }).updateMessageDelivery(rpcInput),
		toResult: outcomeFromPartialMutation,
	})
}

/** Best-effort inbound classification update mirror. */
export async function mirrorMailboxSetMessageClassification(
	input: MailboxSetMessageClassificationInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const { env, ...rpcInput } = input
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-set-message-classification-failed',
		env,
		ownerId: input.ownerId,
		operation: 'set_message_classification',
		call: (ownerId) =>
			mailboxRpc({ env, userId: ownerId }).setMessageClassification(rpcInput),
		toResult: outcomeFromPartialMutation,
	})
}

/** Best-effort metadata-only message delete mirror (no R2). */
export async function mirrorMailboxDeleteMessageMetadata(
	input: MailboxDeleteMessageMetadataInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const { env, ...rpcInput } = input
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-delete-message-metadata-failed',
		env,
		ownerId: input.ownerId,
		operation: 'delete_message_metadata',
		call: (ownerId) =>
			mailboxRpc({ env, userId: ownerId }).deleteMessageMetadata(rpcInput),
		toResult: outcomeFromDeleteResult,
	})
}

/** Best-effort delivery-event delete mirror. */
export async function mirrorMailboxDeleteDeliveryEvent(
	input: MailboxDeleteDeliveryEventInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const { env, ...rpcInput } = input
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-delete-delivery-event-failed',
		env,
		ownerId: input.ownerId,
		operation: 'delete_delivery_event',
		call: (ownerId) =>
			mailboxRpc({ env, userId: ownerId }).deleteDeliveryEvent(rpcInput),
		toResult: outcomeFromDeleteResult,
	})
}

/** Best-effort empty-thread cleanup mirror (D1 deleteEmptyEmailThreads parity). */
export async function mirrorMailboxDeleteThreadIfEmpty(
	input: MailboxDeleteThreadIfEmptyInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const { env, ...rpcInput } = input
	return executeMailboxMirrorRpc({
		tag: 'mailbox-mirror-delete-thread-if-empty-failed',
		env,
		ownerId: input.ownerId,
		operation: 'delete_thread_if_empty',
		call: (ownerId) =>
			mailboxRpc({ env, userId: ownerId }).deleteThreadIfEmpty(rpcInput),
		toResult: outcomeFromDeleteResult,
	})
}
